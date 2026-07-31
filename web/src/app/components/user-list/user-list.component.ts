import { Component, input, inject, EventEmitter, Output, computed } from '@angular/core';
import { ConversationListService } from '../../services/conversation-list.service'
import { ConversationItem } from '../../services/model'
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { FederatedBadgeComponent } from '../federated-badge/federated-badge.component';

@Component({
    selector: 'app-user-list',
    imports: [UserAvatarComponent, IconComponent, FederatedBadgeComponent],
    templateUrl: './user-list.component.html',
    styleUrl: './user-list.component.scss'
})

export class UserListComponent {
    UserAvatarType = UserAvatarType
    AppIconType = AppIconType
    readonly selectedDict = input<Record<number, boolean | undefined>>()
    /** Optional client-side filter text (case-insensitive over display name + handle). */
    readonly filterText = input<string>('')
    /** User ids hidden from the picker (for example, existing members of a group). */
    readonly excludedUserIds = input<ReadonlySet<number>>(new Set<number>())
    private readonly convList = inject(ConversationListService)

    /** The P2P conversations (the friend picker's source) — derived from the live conversation list (the
     *  delta-replay list), no fetch. */
    readonly threadList = computed(() => {
        const excluded = this.excludedUserIds()
        return this.convList.items().filter((t) => t.type === 'P2P' && !excluded.has(t.peerUser.id))
    })

    readonly dispThreadList = computed(() => {
        const q = (this.filterText() ?? '').trim().toLowerCase()
        const filtered = q
            ? this.threadList().filter((t) => {
                const name = (t.peerUser.name ?? '').toLowerCase()
                const handle = (t.peerUser.account ?? '').toLowerCase()
                return name.includes(q) || handle.includes(q)
            })
            : this.threadList()
        const selectedDict = this.selectedDict()
        if (selectedDict !== undefined) {
            return filtered.map((thread) => {
                return { ...thread, selected: selectedDict[thread.id] } as (ConversationItem & { selected: undefined })
            })
        } else { return filtered as (ConversationItem & { selected: undefined })[] }
    })

    @Output() onSelect = new EventEmitter<ConversationItem & { selected: undefined }>()

    onUsrTrdClick(userMsgTrd: ConversationItem & { selected: undefined }) {
        this.onSelect.emit(userMsgTrd)
    }
}
