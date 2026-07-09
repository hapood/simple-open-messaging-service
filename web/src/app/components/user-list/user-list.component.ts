import { Component, input, signal, EventEmitter, Output, computed } from '@angular/core';
import { UserService } from '../../services/user.service'
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
    readonly threadList = signal<ConversationItem[]>([])

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

    constructor(private userService: UserService) { }

    genThreadList() {
        return this.userService.queryUserThreadValid({ take: 10, skip: 0, type: "P2P" }).subscribe(res => {
            if (res.code == 0) {
                this.threadList.set(res.data!)
            } else {
                throw new Error(res.message)
            }
        })
    }

    onUsrTrdClick(userMsgTrd: ConversationItem & { selected: undefined }) {
        this.onSelect.emit(userMsgTrd)
    }

    ngOnInit() {
        this.genThreadList();
    }
}
