import type {
  ProfileEvidenceProjection,
  ProfilePrefetchDemand,
} from '../profile-resolution/profile-resolution-demand.js';

export const MESSAGE_PROFILE_WORK_COMMITTED = 'message.profile-work.committed';

export interface MessageProfileWorkCommittedEvent {
  demands: ProfilePrefetchDemand[];
  evidenceProjections: ProfileEvidenceProjection[];
}
