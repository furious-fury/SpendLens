export interface DatabaseRuntimeConfig {
  dataDirectory: string;
  encryptionMode: "keyring" | "secret-file";
}

export const databasePackageStatus = "reserved-for-section-2" as const;
