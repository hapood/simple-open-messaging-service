import { request } from './client';

interface PublicRoot {
  ed25519: string;
  notBefore: number;
  notAfter: number;
}
interface SigningCertificate extends PublicRoot {
  keyId: string;
  root: string;
  authorizationSignature: string;
}
interface CertificateEvidence {
  subject: Record<string, string | string[] | undefined>;
  issuer: Record<string, string | string[] | undefined>;
  validFrom: string;
  validTo: string;
  fingerprint: string;
}
type SrvEvidence =
  | { kind: 'empty' | 'disabled' }
  | { kind: 'invalid'; reason: 'mixed' | 'fields' }
  | {
      kind: 'targets';
      records: {
        priority: number;
        weight: number;
        port: number;
        host: string;
        display: string;
      }[];
      targets: { host: string; port: number }[];
    };
type NetworkCheck = {
  status: 'ok' | 'warn' | 'fail' | 'skip';
  detail: string;
} & (
  | {
      name: 'dns';
      evidence?: { host: string; addresses: string[] };
    }
  | { name: 'srv'; evidence?: SrvEvidence }
  | {
      name: 'https';
      evidence?: {
        address: string;
        port: number;
        certificate: CertificateEvidence | null;
      };
    }
  | {
      name: 'federation';
      evidence?: {
        protocolVersions: number[];
        roots: PublicRoot[];
        keys: SigningCertificate[];
      };
    }
);

export interface LocalInformation {
  checkedAt: number;
  version: string;
  uptimeSeconds: number;
  startedAt: number;
  runtime: string;
  nodeVersion: string;
  interfaces: {
    name: string;
    address: string;
    family: 4 | 6;
    cidr: string | null;
    scope: string;
  }[];
  configuration: {
    origin: string | null;
    tlsMode: string;
    lanDomain: string | null;
    insecureHttp: boolean;
  };
  identity: null | {
    namespaceId: number;
    domain: string;
    protocolVersions: number[];
    algorithm: string;
    keyId: string;
    publicKey: string;
    rootPublicKey: string;
    createdAt: number;
    roots: {
      id: number;
      rootPublicKey: string;
      notBefore: number;
      notAfter: number;
      claimable: boolean;
      unpublishedAt: number | null;
    }[];
    certificates: SigningCertificate[];
  };
}
export interface NetworkReport {
  target: string;
  policy: {
    freshConnection: boolean;
    publicDestinationsOnly: boolean;
    connectTimeoutMs: number;
    callTimeoutMs: number;
  };
  route: {
    domain: string;
    host: string;
    port: number;
    origin: string;
  } | null;
  checkedAt: number;
  durationMs: number;
  checks: NetworkCheck[];
}
export const getLocalInformation = () =>
  request<LocalInformation>('/admin/local-information');
export const diagnoseNetwork = (target: string) =>
  request<NetworkReport>('/admin/network/diagnose', { target });
