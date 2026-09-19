import { createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

import {
  createProfileSettingsExport,
  DEFAULT_PROFILE_SETTINGS,
  isProfileDrawingPalettes,
  isProfileSettings,
  readKeyboardPanSpeedMultiplier,
  type ProfileDrawingPalettes,
  type ProfileSettings,
  type ProfileSettingsExport,
  type ProfileSettingsRecord,
} from "@squillpad/core-model";
import { ProfileSettingsStore } from "@squillpad/storage";

import { isLoopbackAddress } from "./security.js";

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const MAX_SESSIONS_PER_ACCOUNT = 10;
const SCRYPT_OPTIONS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const SESSION_COOKIE_PREFIX = "squillpad_session=";
const WEBSOCKET_TOKEN_PREFIX = "squillpad-token.";
export const CANVAS_TOOLBAR_HEIGHT_MIN = 24;
export const CANVAS_TOOLBAR_HEIGHT_MAX = 120;

interface StoredAccount {
  readonly username: string;
  readonly salt: string;
  readonly passwordHash: string;
  readonly createdAt: string;
  readonly preferences?: AccountPreferences;
}

interface AccountPreferences {
  readonly toolbarHeight?: number;
  readonly palmRejection?: boolean;
  readonly drawingPalettes?: ProfileDrawingPalettes;
}

interface StoredSession {
  readonly username: string;
  readonly tokenHash: string;
  readonly createdAt: string;
}

interface CredentialDocument {
  readonly version: 1;
  readonly accounts: readonly StoredAccount[];
  readonly sessions: readonly StoredSession[];
}

export interface AuthenticationStatus {
  readonly authenticated: boolean;
  readonly canRegister: boolean;
  readonly hasAccounts: boolean;
  readonly hostAuthorized: boolean;
  readonly profileSettingsAvailable?: boolean;
  readonly profileSettings?: ProfileSettings;
  readonly palmRejection: boolean;
  readonly toolbarHeight?: number;
  readonly drawingPalettes?: ProfileDrawingPalettes;
  readonly username?: string;
}

/** Owns per-project password credentials and revocable persistent sessions. */
export class AuthenticationService {
  readonly #accessToken: string | undefined;
  readonly #filePath: string;
  readonly #profileSettings: ProfileSettingsStore | undefined;
  readonly invitationToken = randomBytes(32).toString("base64url");
  readonly #sessionListeners = new Set<() => void>();
  #sessionHashes: Set<string>;
  #document: CredentialDocument;
  #mutationQueue = Promise.resolve();
  #writeQueue = Promise.resolve();

  private constructor(
    filePath: string,
    accessToken: string | undefined,
    document: CredentialDocument,
    profileSettings: ProfileSettingsStore | undefined,
  ) {
    this.#filePath = filePath;
    this.#accessToken = accessToken;
    this.#document = document;
    this.#sessionHashes = new Set(document.sessions.map((session) => session.tokenHash));
    this.#profileSettings = profileSettings;
  }

  static async open(
    projectRoot: string,
    accessToken?: string,
    profileSettings?: ProfileSettingsStore,
  ): Promise<AuthenticationService> {
    const directory = join(projectRoot, ".squillpad-runtime", "auth");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStatus = await lstat(directory);
    if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
      throw new Error("The project authentication path must be a real directory");
    }
    await chmod(directory, 0o700);
    const filePath = join(directory, "credentials.json");
    let document: CredentialDocument = { version: 1, accounts: [], sessions: [] };
    try {
      const fileStatus = await lstat(filePath);
      if (!fileStatus.isFile() || fileStatus.isSymbolicLink() || fileStatus.nlink !== 1) {
        throw new Error("The project credential store must be a regular private file");
      }
      await chmod(filePath, 0o600);
      document = parseCredentialDocument(await readFile(filePath, "utf8"));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    return new AuthenticationService(filePath, accessToken, document, profileSettings);
  }

  status(request: IncomingMessage): AuthenticationStatus {
    const credential = requestCredential(request);
    const hostAuthorized = this.isHostRequest(request);
    const username = this.#sessionUsername(requestSessionCredential(request) ?? credential);
    const account = this.#document.accounts.find((candidate) => candidate.username === username);
    const profile = username === undefined ? undefined : this.#profileSettings?.get(username);
    const toolbarHeight = profile?.toolbarHeight ?? account?.preferences?.toolbarHeight;
    const palmRejection = profile?.palmRejection ?? account?.preferences?.palmRejection ?? false;
    const drawingPalettes = profile?.drawingPalettes ?? account?.preferences?.drawingPalettes;
    return {
      authenticated: hostAuthorized || username !== undefined,
      canRegister: this.canRegister(request),
      hasAccounts: this.#document.accounts.length > 0,
      hostAuthorized,
      ...(this.#profileSettings === undefined ? {} : { profileSettingsAvailable: true }),
      ...(profile === undefined ? {} : { profileSettings: cloneProfileSettings(profile) }),
      palmRejection,
      ...(toolbarHeight === undefined ? {} : { toolbarHeight }),
      ...(drawingPalettes === undefined ? {} : { drawingPalettes }),
      ...(username === undefined ? {} : { username }),
    };
  }

  acceptsCredential(credential: string | undefined): boolean {
    return this.#isHostCredential(credential) || this.#sessionUsername(credential) !== undefined;
  }

  isHostRequest(request: IncomingMessage): boolean {
    return (
      isLoopbackAddress(request.socket.remoteAddress) &&
      this.#isHostCredential(requestCredential(request))
    );
  }

  canRegister(request: IncomingMessage): boolean {
    const credential = requestCredential(request);
    return (
      this.isHostRequest(request) ||
      (this.#accessToken !== undefined &&
        credential !== undefined &&
        safeStringEqual(credential, this.invitationToken))
    );
  }

  acceptsRequest(request: IncomingMessage, websocket = false): boolean {
    const credential = requestSessionCredential(request) ?? requestCredential(request, websocket);
    return (
      this.#sessionUsername(credential) !== undefined ||
      (isLoopbackAddress(request.socket.remoteAddress) && this.#isHostCredential(credential))
    );
  }

  /** Synchronous notification prevents revoked sockets receiving further updates. */
  onSessionsRevoked(listener: () => void): () => void {
    this.#sessionListeners.add(listener);
    return () => {
      this.#sessionListeners.delete(listener);
    };
  }

  async register(usernameInput: string, password: string): Promise<string> {
    return this.#exclusive(async () => {
      const username = normalizeUsername(usernameInput);
      if (this.#document.accounts.some((account) => account.username === username)) {
        throw new AuthenticationError(409, "That username is already registered");
      }
      const salt = randomBytes(16);
      const passwordHash = await derivePassword(password, salt);
      const account: StoredAccount = {
        username,
        salt: salt.toString("base64url"),
        passwordHash: passwordHash.toString("base64url"),
        createdAt: new Date().toISOString(),
      };
      const session = createSession(username);
      this.#document = {
        version: 1,
        accounts: [...this.#document.accounts, account],
        sessions: appendSession(this.#document.sessions, session.stored),
      };
      await this.#persist();
      return session.token;
    });
  }

  async login(usernameInput: string, password: string): Promise<string> {
    return this.#exclusive(async () => {
      const username = normalizeUsername(usernameInput);
      const account = this.#document.accounts.find((candidate) => candidate.username === username);
      const salt =
        account === undefined ? Buffer.alloc(16) : Buffer.from(account.salt, "base64url");
      const actual = await derivePassword(password, salt);
      const expected =
        account === undefined
          ? Buffer.alloc(actual.length)
          : Buffer.from(account.passwordHash, "base64url");
      if (
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual) ||
        account === undefined
      ) {
        throw new AuthenticationError(401, "Invalid username or password");
      }
      const session = createSession(username);
      this.#document = {
        ...this.#document,
        sessions: appendSession(this.#document.sessions, session.stored),
      };
      await this.#persist();
      return session.token;
    });
  }

  async logout(request: IncomingMessage): Promise<void> {
    await this.#exclusive(async () => {
      const credential = requestSessionCredential(request);
      if (credential === undefined) return;
      const tokenHash = hashToken(credential);
      const sessions = this.#document.sessions.filter((session) => session.tokenHash !== tokenHash);
      if (sessions.length === this.#document.sessions.length) return;
      this.#document = { ...this.#document, sessions };
      await this.#persist();
    });
  }

  async updateToolbarHeight(request: IncomingMessage, toolbarHeight: number): Promise<void> {
    await this.#exclusive(async () => {
      const username = this.#sessionUsername(requestSessionCredential(request));
      if (username === undefined) {
        throw new AuthenticationError(403, "A signed-in profile is required for this preference");
      }
      if (!isCanvasToolbarHeight(toolbarHeight)) {
        throw new Error("toolbarHeight must be an integer between 24 and 120 pixels");
      }
      const account = this.#document.accounts.find((candidate) => candidate.username === username);
      if (account === undefined) throw new AuthenticationError(401, "Invalid profile session");
      if (this.#profileSettings !== undefined) {
        const current = this.#profileSettings.get(username) ?? this.#profileSettingsFor(account);
        await this.#profileSettings.save(username, { ...current, toolbarHeight });
      }
      this.#document = {
        ...this.#document,
        accounts: this.#document.accounts.map((candidate) =>
          candidate.username === username
            ? {
                ...candidate,
                preferences: { ...candidate.preferences, toolbarHeight },
              }
            : candidate,
        ),
      };
      await this.#persist();
    });
  }

  async updatePalmRejection(request: IncomingMessage, palmRejection: boolean): Promise<void> {
    await this.#exclusive(async () => {
      const username = this.#sessionUsername(requestSessionCredential(request));
      if (username === undefined) {
        throw new AuthenticationError(403, "A signed-in profile is required for this preference");
      }
      if (typeof palmRejection !== "boolean") {
        throw new Error("palmRejection must be a boolean");
      }
      const account = this.#document.accounts.find((candidate) => candidate.username === username);
      if (account === undefined) throw new AuthenticationError(401, "Invalid profile session");
      if (this.#profileSettings !== undefined) {
        const current = this.#profileSettings.get(username) ?? this.#profileSettingsFor(account);
        await this.#profileSettings.save(username, { ...current, palmRejection });
      }
      this.#document = {
        ...this.#document,
        accounts: this.#document.accounts.map((candidate) =>
          candidate.username === username
            ? {
                ...candidate,
                preferences: { ...candidate.preferences, palmRejection },
              }
            : candidate,
        ),
      };
      await this.#persist();
    });
  }

  async updateDrawingPalettes(
    request: IncomingMessage,
    drawingPalettes: ProfileDrawingPalettes,
  ): Promise<void> {
    await this.#exclusive(async () => {
      const username = this.#sessionUsername(requestSessionCredential(request));
      if (username === undefined) {
        throw new AuthenticationError(403, "A signed-in profile is required for this preference");
      }
      if (!isProfileDrawingPalettes(drawingPalettes)) {
        throw new Error("drawingPalettes has an invalid profile palette shape");
      }
      const account = this.#document.accounts.find((candidate) => candidate.username === username);
      if (account === undefined) throw new AuthenticationError(401, "Invalid profile session");
      if (this.#profileSettings !== undefined) {
        const current = this.#profileSettings.get(username) ?? this.#profileSettingsFor(account);
        await this.#profileSettings.save(username, { ...current, drawingPalettes });
      }
      this.#document = {
        ...this.#document,
        accounts: this.#document.accounts.map((candidate) =>
          candidate.username === username
            ? {
                ...candidate,
                preferences: { ...candidate.preferences, drawingPalettes },
              }
            : candidate,
        ),
      };
      await this.#persist();
    });
  }

  listAccounts(): readonly { username: string; createdAt: string }[] {
    return this.#document.accounts.map(({ username, createdAt }) => ({ username, createdAt }));
  }

  /** Returns the complete settings record for the signed-in profile. */
  profileSettings(request: IncomingMessage): ProfileSettings {
    const username = this.#requireProfileUsername(request);
    const account = this.#document.accounts.find((candidate) => candidate.username === username);
    if (account === undefined) throw new AuthenticationError(401, "Invalid profile session");
    return cloneProfileSettings(
      this.#profileSettings?.get(username) ?? this.#profileSettingsFor(account),
    );
  }

  /** Replaces and persists the complete settings record for the signed-in profile. */
  async saveProfileSettings(
    request: IncomingMessage,
    settings: ProfileSettings,
  ): Promise<ProfileSettings> {
    return this.#exclusive(async () => {
      const username = this.#requireProfileUsername(request);
      const account = this.#document.accounts.find((candidate) => candidate.username === username);
      if (account === undefined) throw new AuthenticationError(401, "Invalid profile session");
      if (!isProfileSettings(settings)) throw new Error("Profile settings are invalid");
      if (this.#profileSettings === undefined) {
        throw new AuthenticationError(503, "Profile settings storage is unavailable");
      }
      const saved = await this.#profileSettings.save(username, settings);
      await this.#persistLegacyProfilePreferences(username, account, saved);
      return saved;
    });
  }

  /** Merges a settings-only import into the signed-in profile and persists it. */
  async mergeProfileSettings(
    request: IncomingMessage,
    settings: ProfileSettings,
  ): Promise<ProfileSettings> {
    return this.#exclusive(async () => {
      const username = this.#requireProfileUsername(request);
      const account = this.#document.accounts.find((candidate) => candidate.username === username);
      if (account === undefined) throw new AuthenticationError(401, "Invalid profile session");
      if (!isProfileSettings(settings)) throw new Error("Profile settings are invalid");
      if (this.#profileSettings === undefined) {
        throw new AuthenticationError(503, "Profile settings storage is unavailable");
      }
      const saved = await this.#profileSettings.merge(username, settings);
      await this.#persistLegacyProfilePreferences(username, account, saved);
      return saved;
    });
  }

  /** Creates a settings-only export for the signed-in profile. */
  profileSettingsExport(request: IncomingMessage): ProfileSettingsExport {
    return createProfileSettingsExport(this.profileSettings(request));
  }

  /** Lists every settings-only profile available in the synchronized project. */
  listProfileSettings(): readonly ProfileSettingsRecord[] {
    return this.#profileSettings?.list() ?? [];
  }

  async resetPassword(usernameInput: string, password: string): Promise<void> {
    await this.#exclusive(async () => {
      const username = normalizeUsername(usernameInput);
      const existing = this.#document.accounts.find((account) => account.username === username);
      if (existing === undefined) throw new AuthenticationError(404, "Account not found");
      const salt = randomBytes(16);
      const passwordHash = await derivePassword(password, salt);
      this.#document = {
        version: 1,
        accounts: this.#document.accounts.map((account) =>
          account.username === username
            ? {
                ...account,
                salt: salt.toString("base64url"),
                passwordHash: passwordHash.toString("base64url"),
              }
            : account,
        ),
        sessions: this.#document.sessions.filter((session) => session.username !== username),
      };
      await this.#persist();
    });
  }

  async removeAccount(usernameInput: string): Promise<void> {
    await this.#exclusive(async () => {
      const username = normalizeUsername(usernameInput);
      if (!this.#document.accounts.some((account) => account.username === username)) {
        throw new AuthenticationError(404, "Account not found");
      }
      this.#document = {
        version: 1,
        accounts: this.#document.accounts.filter((account) => account.username !== username),
        sessions: this.#document.sessions.filter((session) => session.username !== username),
      };
      await this.#persist();
    });
  }

  #isHostCredential(credential: string | undefined): boolean {
    if (credential === undefined || this.#accessToken === undefined) return false;
    return safeStringEqual(credential, this.#accessToken);
  }

  #sessionUsername(credential: string | undefined): string | undefined {
    if (credential === undefined) return undefined;
    const tokenHash = hashToken(credential);
    return this.#document.sessions.find((session) => session.tokenHash === tokenHash)?.username;
  }

  #requireProfileUsername(request: IncomingMessage): string {
    const username = this.#sessionUsername(requestSessionCredential(request));
    if (username === undefined) {
      throw new AuthenticationError(403, "A signed-in profile is required for this preference");
    }
    return username;
  }

  #profileSettingsFor(account: StoredAccount): ProfileSettings {
    const preferences = account.preferences;
    return cloneProfileSettings({
      ...DEFAULT_PROFILE_SETTINGS,
      toolbarHeight: preferences?.toolbarHeight ?? DEFAULT_PROFILE_SETTINGS.toolbarHeight,
      palmRejection: preferences?.palmRejection ?? DEFAULT_PROFILE_SETTINGS.palmRejection,
      drawingPalettes: preferences?.drawingPalettes ?? DEFAULT_PROFILE_SETTINGS.drawingPalettes,
    });
  }

  async #persistLegacyProfilePreferences(
    username: string,
    account: StoredAccount,
    settings: ProfileSettings,
  ): Promise<void> {
    this.#document = {
      ...this.#document,
      accounts: this.#document.accounts.map((candidate) =>
        candidate.username === username
          ? {
              ...candidate,
              preferences: {
                ...account.preferences,
                toolbarHeight: settings.toolbarHeight,
                palmRejection: settings.palmRejection,
                drawingPalettes: settings.drawingPalettes,
              },
            }
          : candidate,
      ),
    };
    await this.#persist();
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationQueue.then(operation);
    this.#mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #persist(): Promise<void> {
    const current = new Set(this.#document.sessions.map((session) => session.tokenHash));
    const revoked = [...this.#sessionHashes].some((hash) => !current.has(hash));
    this.#sessionHashes = current;
    if (revoked) for (const listener of this.#sessionListeners) listener();
    const contents = JSON.stringify(this.#document, null, 2) + "\n";
    const operation = this.#writeQueue.then(async () => {
      const temporaryPath = `${this.#filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
      try {
        await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporaryPath, this.#filePath);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    });
    this.#writeQueue = operation.catch(() => undefined);
    return operation;
  }
}

export class AuthenticationError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "AuthenticationError";
    this.status = status;
  }
}

export function requestCredential(request: IncomingMessage, websocket = false): string | undefined {
  const protocolCredential = websocket
    ? request.headers["sec-websocket-protocol"]
        ?.split(",")
        .map((value) => value.trim())
        .find((value) => value.startsWith(WEBSOCKET_TOKEN_PREFIX))
        ?.slice(WEBSOCKET_TOKEN_PREFIX.length)
    : undefined;
  const authorization = request.headers.authorization;
  const bearerCredential = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : undefined;
  return protocolCredential ?? bearerCredential ?? requestSessionCredential(request);
}

export function requestSessionCredential(request: IncomingMessage): string | undefined {
  return sessionCookie(request.headers.cookie);
}

export function sessionCookieHeader(token: string, secure = false): string {
  return `${SESSION_COOKIE_PREFIX}${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=315360000${secure ? "; Secure" : ""}`;
}

export function expiredSessionCookieHeader(): string {
  return `${SESSION_COOKIE_PREFIX}; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function normalizeUsername(value: string): string {
  const username = value.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new AuthenticationError(
      400,
      "Username must be 3–32 lowercase letters, numbers, dots, underscores, or hyphens",
    );
  }
  return username;
}

async function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password.normalize("NFKC"), salt, 32, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error === null) resolve(derivedKey);
      else reject(error);
    });
  });
}

function createSession(username: string): { token: string; stored: StoredSession } {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    stored: { username, tokenHash: hashToken(token), createdAt: new Date().toISOString() },
  };
}

function appendSession(
  sessions: readonly StoredSession[],
  session: StoredSession,
): readonly StoredSession[] {
  const retainedForAccount = sessions
    .filter((candidate) => candidate.username === session.username)
    .slice(-(MAX_SESSIONS_PER_ACCOUNT - 1));
  const otherAccounts = sessions.filter((candidate) => candidate.username !== session.username);
  return [...otherAccounts, ...retainedForAccount, session];
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function safeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCredentialDocument(contents: string): CredentialDocument {
  const value: unknown = JSON.parse(contents);
  if (typeof value !== "object" || value === null) throw new Error("Invalid credential store");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.accounts) || !Array.isArray(record.sessions)) {
    throw new Error("Unsupported credential store");
  }
  const accounts = record.accounts.map(parseAccount);
  const sessions = record.sessions.map(parseSession);
  if (new Set(accounts.map((account) => account.username)).size !== accounts.length) {
    throw new Error("Credential store contains duplicate accounts");
  }
  const usernames = new Set(accounts.map((account) => account.username));
  if (
    sessions.some((session) => !usernames.has(session.username)) ||
    new Set(sessions.map((session) => session.tokenHash)).size !== sessions.length
  ) {
    throw new Error("Credential store contains invalid sessions");
  }
  return { version: 1, accounts, sessions };
}

function parseAccount(value: unknown): StoredAccount {
  if (typeof value !== "object" || value === null) throw new Error("Invalid account record");
  const record = value as Record<string, unknown>;
  if (
    ![record.username, record.salt, record.passwordHash, record.createdAt].every(
      (item) => typeof item === "string",
    )
  ) {
    throw new Error("Invalid account record");
  }
  if (
    !USERNAME_PATTERN.test(record.username as string) ||
    !/^[A-Za-z0-9_-]{22}$/.test(record.salt as string) ||
    !/^[A-Za-z0-9_-]{43}$/.test(record.passwordHash as string) ||
    !validDate(record.createdAt as string)
  ) {
    throw new Error("Invalid account record");
  }
  const preferences =
    record.preferences === undefined ? undefined : parseAccountPreferences(record.preferences);
  return {
    ...record,
    ...(preferences === undefined ? {} : { preferences }),
  } as unknown as StoredAccount;
}

function parseAccountPreferences(value: unknown): AccountPreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid account preferences");
  }
  const toolbarHeight = (value as Record<string, unknown>).toolbarHeight;
  const palmRejection = (value as Record<string, unknown>).palmRejection;
  const drawingPalettes = (value as Record<string, unknown>).drawingPalettes;
  if (
    (toolbarHeight !== undefined && !isCanvasToolbarHeight(toolbarHeight)) ||
    (palmRejection !== undefined && typeof palmRejection !== "boolean") ||
    (drawingPalettes !== undefined && !isProfileDrawingPalettes(drawingPalettes))
  ) {
    throw new Error("Invalid account preferences");
  }
  return {
    ...(toolbarHeight === undefined ? {} : { toolbarHeight }),
    ...(palmRejection === undefined ? {} : { palmRejection }),
    ...(drawingPalettes === undefined ? {} : { drawingPalettes }),
  };
}

export function isCanvasToolbarHeight(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= CANVAS_TOOLBAR_HEIGHT_MIN &&
    value <= CANVAS_TOOLBAR_HEIGHT_MAX
  );
}

function parseSession(value: unknown): StoredSession {
  if (typeof value !== "object" || value === null) throw new Error("Invalid session record");
  const record = value as Record<string, unknown>;
  if (
    ![record.username, record.tokenHash, record.createdAt].every((item) => typeof item === "string")
  ) {
    throw new Error("Invalid session record");
  }
  if (
    !USERNAME_PATTERN.test(record.username as string) ||
    !/^[A-Za-z0-9_-]{43}$/.test(record.tokenHash as string) ||
    !validDate(record.createdAt as string)
  ) {
    throw new Error("Invalid session record");
  }
  return record as unknown as StoredSession;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function validDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function cloneProfileSettings(settings: ProfileSettings): ProfileSettings {
  return {
    ...settings,
    application: { ...settings.application },
    drawing: {
      ...settings.drawing,
      pen: { ...settings.drawing.pen },
      highlighter: { ...settings.drawing.highlighter },
      shape: { ...settings.drawing.shape },
    },
    drawingPalettes: {
      pen: clonePalette(settings.drawingPalettes.pen),
      highlighter: clonePalette(settings.drawingPalettes.highlighter),
      shape: clonePalette(settings.drawingPalettes.shape),
    },
    keyboardPanSpeedMultiplier: readKeyboardPanSpeedMultiplier(settings.keyboardPanSpeedMultiplier),
  };
}

function clonePalette(
  palette: ProfileSettings["drawingPalettes"]["pen"],
): ProfileSettings["drawingPalettes"]["pen"] {
  return { ...palette, slots: palette.slots.map((slot) => ({ ...slot })) };
}

function sessionCookie(header: string | undefined): string | undefined {
  const value = header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(SESSION_COOKIE_PREFIX))
    ?.slice(SESSION_COOKIE_PREFIX.length);
  return value !== undefined && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
