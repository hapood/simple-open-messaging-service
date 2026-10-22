import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service.js';
import { profileTable } from '../../database/schema.js';

/** Read the exact immutable profile selected by a visible contact address. */
@Injectable()
export class ContactCardProfileService {
  constructor(private readonly database: DatabaseService) {}

  findProfile(target: {
    account: string;
    namespaceId: number;
    profileRev: number;
  }) {
    if (target.profileRev === 0) return Promise.resolve(null);
    return this.database.db.query.profileTable.findFirst({
      where: and(
        eq(profileTable.account, target.account),
        eq(
          profileTable.publisherNamespaceId,
          target.namespaceId === 0 ? 0 : target.namespaceId,
        ),
        eq(profileTable.profileNamespaceId, target.namespaceId),
        eq(profileTable.profileRev, target.profileRev),
      ),
    });
  }
}
