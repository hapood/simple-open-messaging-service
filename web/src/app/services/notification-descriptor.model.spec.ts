import {
  NotificationDescriptor,
  NotifAction,
} from './notification-descriptor.model';

/**
 * Shape-lock for the hand-mirrored NotificationDescriptor model.
 *
 * The descriptor contract is authored in `src/notification/notification-descriptor.ts` (backend — the single
 * source of truth) and hand-mirrored in 4 places (backend interface, this web model, the Kotlin
 * `NotifDescriptor`, the Web Push `sw-push.js`). This spec pins the FIELD SET + TYPES the web clients (the
 * popup + the SW) depend on: a dropped, renamed, or retyped field on the web model fails the assignments below
 * at COMPILE time (no runtime `as` escape — `declare const` has no value). The action id + `data` VALUES are
 * additionally pinned end-to-end by `test/notification-action.e2e-spec.ts` (server-side contract).
 *
 * (A stronger check — bidirectional assignability with the OpenAPI-GENERATED type — is possible once the
 *  `/notifications/missed` response carries a typed DTO and `npm run gen:api` regenerates `api-types.ts`.)
 */

/** The exact field contract every client renders — mirrors the backend `NotificationDescriptor`. */
type DescriptorContract = {
  tag: string;
  kind: string;
  title: string;
  body: string;
  count: number;
  lang: string;
  icon: string | null;
  renotify: boolean;
  attention?: 'mention';
  silent?: boolean;
  actions: NotifAction[];
  data: { threadId?: number; seq?: number; [k: string]: unknown };
};

// Compile-time assertion (purely type-level — no runtime value reference): the web model must be
// bidirectionally assignable with the contract. If either direction drifts, the conditional resolves to
// `never` and the `= true` assignment fails to type-check.
type _ModelExtendsContract = NotificationDescriptor extends DescriptorContract
  ? true
  : never;
type _ContractExtendsModel = DescriptorContract extends NotificationDescriptor
  ? true
  : never;
const _assertModelExtendsContract: _ModelExtendsContract = true;
const _assertContractExtendsModel: _ContractExtendsModel = true;
void _assertModelExtendsContract;
void _assertContractExtendsModel;

describe('NotificationDescriptor model (hand-mirror shape-lock vs the backend contract)', () => {
  it('pins the descriptor field set + types the clients depend on (compile-time)', () => {
    // The real assertion is the type-level conditional above; this keeps the spec runner happy.
    expect(true).toBe(true);
  });
});
