-- Group description / intro (群简介): a short, admin-editable blurb rendered as the subtitle line
-- under the group name in the chat header and on the group-info panel. NOT NULL with an empty-string
-- default, mirroring `avatar` — every consumer can treat it as a non-nullable string. Length is capped
-- at the DTO layer (CreateGroupDto / UpdateGroupDto @MaxLength 240).
ALTER TABLE "Group" ADD COLUMN "description" TEXT NOT NULL DEFAULT '';
