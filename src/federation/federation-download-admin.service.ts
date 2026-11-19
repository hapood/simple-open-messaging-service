import { Injectable } from '@nestjs/common';
import { FederationInboundMediaBatchService } from './federation-inbound-media-batch.service.js';

/** Administrative commands delegate execution policy to the inbound lifecycle. */
@Injectable()
export class FederationDownloadAdminService {
  constructor(private readonly batches: FederationInboundMediaBatchService) {}

  stop(batchId: string) {
    return this.batches.stopInboundBatch(batchId);
  }

  retry(batchId: string) {
    return this.batches.retryInboundBatch(batchId);
  }
}
