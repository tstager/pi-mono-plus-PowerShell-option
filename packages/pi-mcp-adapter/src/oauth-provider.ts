import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import {
	type OAuthClientInformationFull,
	OAuthClientInformationFullSchema,
	type OAuthClientInformationMixed,
	type OAuthClientMetadata,
	type OAuthTokens,
	OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { HttpMcpServerOAuthConfig, McpOAuthTokenEndpointAuthMethod } from "./config.js";

const OAUTH_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;
const OAUTH_RESPONSE_TYPES = ["code"] as const;

export type FileBackedOAuthProviderStatus = "configured" | "pending" | "authorized";

export interface FileBackedOAuthProviderRuntimeState {
	status: FileBackedOAuthProviderStatus;
	clientId: string;
	redirectUrl: string;
	authorizationUrl?: string;
	scopes: string[];
	tokenEndpointAuthMethod?: McpOAuthTokenEndpointAuthMethod;
	hasTokens: boolean;
	hasClientInformation: boolean;
	hasCodeVerifier: boolean;
	hasDiscoveryState: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function omitUndefinedProperties<T extends Record<string, unknown>>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function normalizeTextFile(value: string): string {
	return value.trim();
}

function serializeJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

async function ensureParentDirectory(filePath: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
}

async function readTextFileIfPresent(filePath: string): Promise<string | undefined> {
	if (!existsSync(filePath)) {
		return undefined;
	}

	return readFile(filePath, "utf8");
}

async function writeTextFile(filePath: string, value: string): Promise<void> {
	await ensureParentDirectory(filePath);
	await withFileMutationQueue(filePath, async () => {
		await writeFile(filePath, value, "utf8");
	});
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
	await writeTextFile(filePath, serializeJson(value));
}

async function removeFileIfPresent(filePath: string): Promise<void> {
	await withFileMutationQueue(filePath, async () => {
		await rm(filePath, { force: true });
	});
}

function parseDiscoveryState(value: unknown, filePath: string): OAuthDiscoveryState {
	if (!isRecord(value)) {
		throw new Error(`${filePath}: persisted OAuth discovery state must be an object.`);
	}
	if (typeof value.authorizationServerUrl !== "string" || value.authorizationServerUrl.trim().length === 0) {
		throw new Error(`${filePath}: persisted OAuth discovery state must include a non-empty authorizationServerUrl.`);
	}

	return {
		...value,
		authorizationServerUrl: value.authorizationServerUrl,
	};
}

export class FileBackedOAuthClientProvider implements OAuthClientProvider {
	private readonly clientMetadataValue: OAuthClientMetadata;
	private pendingAuthorizationUrl?: string;

	constructor(private readonly config: HttpMcpServerOAuthConfig) {
		const scope = config.scopes?.join(" ");
		this.clientMetadataValue = omitUndefinedProperties({
			redirect_uris: [config.redirectUrl],
			grant_types: [...OAUTH_GRANT_TYPES],
			response_types: [...OAUTH_RESPONSE_TYPES],
			scope,
			token_endpoint_auth_method: config.tokenEndpointAuthMethod,
		});
	}

	get redirectUrl(): string {
		return this.config.redirectUrl;
	}

	get clientMetadata(): OAuthClientMetadata {
		return this.clientMetadataValue;
	}

	private async readConfiguredClientSecret(): Promise<string | undefined> {
		if (this.config.tokenEndpointAuthMethod === "none") {
			return undefined;
		}

		const secretText = await readTextFileIfPresent(this.config.clientSecret.path);
		if (secretText === undefined) {
			throw new Error(`OAuth client secret file not found: ${this.config.clientSecret.path}`);
		}

		const clientSecret = normalizeTextFile(secretText);
		if (clientSecret.length === 0) {
			throw new Error(`OAuth client secret file is empty: ${this.config.clientSecret.path}`);
		}
		return clientSecret;
	}

	private async createConfiguredClientInformation(): Promise<OAuthClientInformationFull> {
		const clientSecret = await this.readConfiguredClientSecret();
		return omitUndefinedProperties({
			...this.clientMetadataValue,
			client_id: this.config.clientId,
			client_secret: clientSecret,
		});
	}

	private async normalizeClientInformation(
		clientInformation: OAuthClientInformationMixed,
	): Promise<OAuthClientInformationFull> {
		const configuredClientInformation = await this.createConfiguredClientInformation();
		return omitUndefinedProperties({
			...configuredClientInformation,
			client_id: clientInformation.client_id,
			client_secret: clientInformation.client_secret ?? configuredClientInformation.client_secret,
			client_id_issued_at: clientInformation.client_id_issued_at,
			client_secret_expires_at: clientInformation.client_secret_expires_at,
			token_endpoint_auth_method:
				configuredClientInformation.token_endpoint_auth_method ??
				("token_endpoint_auth_method" in clientInformation
					? clientInformation.token_endpoint_auth_method
					: undefined),
		});
	}

	private async loadClientInformationFromDisk(): Promise<OAuthClientInformationFull | undefined> {
		const content = await readTextFileIfPresent(this.config.persistence.clientInfoPath);
		if (content === undefined) {
			return undefined;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`${this.config.persistence.clientInfoPath}: failed to parse OAuth client information: ${message}`,
			);
		}

		const result = OAuthClientInformationFullSchema.safeParse(parsed);
		if (!result.success) {
			throw new Error(
				`${this.config.persistence.clientInfoPath}: invalid OAuth client information: ${result.error.message}`,
			);
		}

		return result.data;
	}

	private async loadTokensFromDisk(): Promise<OAuthTokens | undefined> {
		const content = await readTextFileIfPresent(this.config.persistence.tokensPath);
		if (content === undefined) {
			return undefined;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`${this.config.persistence.tokensPath}: failed to parse OAuth tokens: ${message}`);
		}

		const result = OAuthTokensSchema.safeParse(parsed);
		if (!result.success) {
			throw new Error(`${this.config.persistence.tokensPath}: invalid OAuth tokens: ${result.error.message}`);
		}

		return result.data;
	}

	private async loadCodeVerifierFromDisk(): Promise<string | undefined> {
		const content = await readTextFileIfPresent(this.config.persistence.codeVerifierPath);
		if (content === undefined) {
			return undefined;
		}

		const codeVerifier = normalizeTextFile(content);
		if (codeVerifier.length === 0) {
			throw new Error(`${this.config.persistence.codeVerifierPath}: persisted OAuth PKCE verifier is empty.`);
		}
		return codeVerifier;
	}

	private async loadDiscoveryStateFromDisk(): Promise<OAuthDiscoveryState | undefined> {
		const content = await readTextFileIfPresent(this.config.persistence.discoveryStatePath);
		if (content === undefined) {
			return undefined;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`${this.config.persistence.discoveryStatePath}: failed to parse OAuth discovery state: ${message}`,
			);
		}

		return parseDiscoveryState(parsed, this.config.persistence.discoveryStatePath);
	}

	async clientInformation(): Promise<OAuthClientInformationFull> {
		const persistedClientInformation = await this.loadClientInformationFromDisk();
		const nextClientInformation =
			persistedClientInformation !== undefined
				? await this.normalizeClientInformation(persistedClientInformation)
				: await this.createConfiguredClientInformation();

		if (
			persistedClientInformation === undefined ||
			JSON.stringify(persistedClientInformation) !== JSON.stringify(nextClientInformation)
		) {
			await this.saveClientInformation(nextClientInformation);
		}

		return nextClientInformation;
	}

	async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
		await writeJsonFile(
			this.config.persistence.clientInfoPath,
			await this.normalizeClientInformation(clientInformation),
		);
	}

	tokens(): Promise<OAuthTokens | undefined> {
		return this.loadTokensFromDisk();
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		this.pendingAuthorizationUrl = undefined;
		await writeJsonFile(this.config.persistence.tokensPath, tokens);
	}

	redirectToAuthorization(authorizationUrl: URL): void {
		this.pendingAuthorizationUrl = authorizationUrl.href;
	}

	saveCodeVerifier(codeVerifier: string): Promise<void> {
		return writeTextFile(this.config.persistence.codeVerifierPath, `${codeVerifier}\n`);
	}

	async codeVerifier(): Promise<string> {
		const codeVerifier = await this.loadCodeVerifierFromDisk();
		if (codeVerifier === undefined) {
			throw new Error(`No OAuth PKCE verifier persisted at ${this.config.persistence.codeVerifierPath}.`);
		}
		return codeVerifier;
	}

	saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
		return writeJsonFile(this.config.persistence.discoveryStatePath, state);
	}

	discoveryState(): Promise<OAuthDiscoveryState | undefined> {
		return this.loadDiscoveryStateFromDisk();
	}

	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		if (scope === "all" || scope === "client") {
			await removeFileIfPresent(this.config.persistence.clientInfoPath);
		}
		if (scope === "all" || scope === "tokens") {
			await removeFileIfPresent(this.config.persistence.tokensPath);
		}
		if (scope === "all" || scope === "verifier") {
			await removeFileIfPresent(this.config.persistence.codeVerifierPath);
		}
		if (scope === "all" || scope === "discovery") {
			await removeFileIfPresent(this.config.persistence.discoveryStatePath);
		}
		if (scope === "all" || scope === "tokens" || scope === "verifier") {
			this.pendingAuthorizationUrl = undefined;
		}
	}

	async getRuntimeState(): Promise<FileBackedOAuthProviderRuntimeState> {
		const [tokens, clientInformation, codeVerifier, discoveryState] = await Promise.all([
			this.loadTokensFromDisk(),
			this.loadClientInformationFromDisk(),
			this.loadCodeVerifierFromDisk(),
			this.loadDiscoveryStateFromDisk(),
		]);

		return {
			status:
				tokens !== undefined
					? "authorized"
					: this.pendingAuthorizationUrl !== undefined || codeVerifier !== undefined
						? "pending"
						: "configured",
			clientId: this.config.clientId,
			redirectUrl: this.config.redirectUrl,
			authorizationUrl: this.pendingAuthorizationUrl,
			scopes: [...(this.config.scopes ?? [])],
			tokenEndpointAuthMethod: this.config.tokenEndpointAuthMethod,
			hasTokens: tokens !== undefined,
			hasClientInformation: clientInformation !== undefined,
			hasCodeVerifier: codeVerifier !== undefined,
			hasDiscoveryState: discoveryState !== undefined,
		};
	}
}

export function createFileBackedOAuthClientProvider(config: HttpMcpServerOAuthConfig): FileBackedOAuthClientProvider {
	return new FileBackedOAuthClientProvider(config);
}
