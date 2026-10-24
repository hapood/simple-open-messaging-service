import { Injectable } from '@nestjs/common';
import { deriveOrigin } from '../../common/origin.js';
import { SERVER_VERSION } from '../../common/version.js';
import { KeypairService } from '../keypair.service.js';
import { FEDERATION_PROTOCOL_VERSION } from '../federation-protocol.js';
import { NetworkInspectionService } from './network-inspection.service.js';

/** Public local facts only. No discovery, DNS, HTTP, clock probes, or key maintenance. */
@Injectable()
export class LocalInformationService {
  constructor(
    private readonly keys: KeypairService,
    private readonly network: NetworkInspectionService,
  ) {}

  get() {
    const now = Date.now();
    const uptimeSeconds = Math.floor(process.uptime());
    const available = this.keys.getStatus().available;
    const local = this.network.local();
    return {
      checkedAt: now,
      version: SERVER_VERSION,
      uptimeSeconds,
      startedAt: now - uptimeSeconds * 1000,
      runtime: local.runtime,
      nodeVersion: process.version,
      interfaces: local.interfaces,
      configuration: {
        origin: available ? deriveOrigin(this.keys.getIdentityDomain()) : null,
        tlsMode: process.env.SOMS_TLS_MODE ?? 'standard',
        lanDomain: process.env.SOMS_LAN_DOMAIN?.trim() || null,
        insecureHttp: process.env.SOMS_ALLOW_INSECURE_HTTP === '1',
      },
      identity: available
        ? {
            namespaceId: 0,
            domain: this.keys.getIdentityDomain(),
            protocolVersions: [FEDERATION_PROTOCOL_VERSION],
            algorithm: 'Ed25519',
            keyId: this.keys.getKeyId(),
            publicKey: this.keys.getPublicKeyB64(),
            rootPublicKey: this.keys.getRootPublicKeyB64(),
            createdAt: this.keys.getCreatedAt(),
            roots: this.keys.getRootEpochs(),
            certificates: this.keys.getSigningKeyCertificates(),
          }
        : null,
    };
  }
}
