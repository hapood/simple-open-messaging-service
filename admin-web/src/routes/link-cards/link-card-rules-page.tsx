import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link2, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { LinkCardRule, LinkCardRuleInput } from '@/api/link-card-rules';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TableBodyState } from '@/components/common/table-state';
import {
  useCreateLinkCardRule,
  useDeleteLinkCardRule,
  useLinkCardRules,
  useUpdateLinkCardRule,
} from '@/hooks/use-link-card-rules';
import { useIsAdminPlus } from '@/hooks/use-me';
import { formatApiError } from '@/lib/format-error';

const blank: LinkCardRuleInput = {
  hostname: '',
  note: '',
};

export function LinkCardRulesPage() {
  const { t } = useTranslation();
  const canEdit = useIsAdminPlus();
  const { data, isLoading, error } = useLinkCardRules();
  const createRule = useCreateLinkCardRule();
  const updateRule = useUpdateLinkCardRule();
  const deleteRule = useDeleteLinkCardRule();
  const [editing, setEditing] = useState<LinkCardRule | null | undefined>(
    undefined,
  );
  const [form, setForm] = useState<LinkCardRuleInput>(blank);

  useEffect(() => {
    if (editing === undefined) return;
    setForm(
      editing
        ? {
            hostname: editing.hostname,
            note: editing.note ?? '',
          }
        : blank,
    );
  }, [editing]);

  const pending = createRule.isPending || updateRule.isPending;

  async function save() {
    try {
      if (editing)
        await updateRule.mutateAsync({ id: editing.id, input: form });
      else await createRule.mutateAsync(form);
      toast.success(t('linkCards.saved'));
      setEditing(undefined);
    } catch (e) {
      toast.error(formatApiError(e));
    }
  }

  async function remove(rule: LinkCardRule) {
    if (
      !window.confirm(t('linkCards.confirmDelete', { name: rule.hostname }))
    )
      return;
    try {
      await deleteRule.mutateAsync(rule.id);
      toast.success(t('linkCards.deleted'));
    } catch (e) {
      toast.error(formatApiError(e));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('linkCards.title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('linkCards.desc')}</p>
        </div>
        <Button disabled={!canEdit} onClick={() => setEditing(null)}>
          <Plus className="size-4" /> {t('linkCards.add')}
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('linkCards.hostname')}</TableHead>
              <TableHead>{t('linkCards.note')}</TableHead>
              <TableHead className="w-28" />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableBodyState
              loading={isLoading}
              error={error}
              empty={!data?.length}
              colSpan={3}
              skeletonRows={8}
              emptyMessage={
                <>
                  <Link2 className="mx-auto mb-2 size-5 opacity-40" />
                  {t('linkCards.empty')}
                </>
              }
            >
              {data?.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell className="font-medium">
                    <span className="font-mono text-xs">{rule.hostname}</span>
                  </TableCell>
                  <TableCell>{rule.note || '—'}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!canEdit}
                        onClick={() => setEditing(rule)}
                      >
                        <Pencil className="size-4" />
                        <span className="sr-only">{t('common.edit')}</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!canEdit || deleteRule.isPending}
                        onClick={() => remove(rule)}
                      >
                        <Trash2 className="size-4" />
                        <span className="sr-only">{t('common.delete')}</span>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBodyState>
          </TableBody>
        </Table>
      </div>

      <Dialog
        open={editing !== undefined}
        onOpenChange={(open) => !open && setEditing(undefined)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing ? t('linkCards.edit') : t('linkCards.add')}
            </DialogTitle>
            <DialogDescription>{t('linkCards.formDesc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Label htmlFor="rule-hostname">{t('linkCards.hostname')}</Label>
            <Input
              id="rule-hostname"
              value={form.hostname}
              placeholder="example.com"
              onChange={(e) => setForm({ ...form, hostname: e.target.value })}
            />
            <Label htmlFor="rule-note">{t('linkCards.note')}</Label>
            <Input
              id="rule-note"
              value={form.note ?? ''}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </div>
          <DialogFooter>
            <Button
              onClick={save}
              disabled={pending || !form.hostname}
            >
              {pending && <Loader2 className="size-4 animate-spin" />}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
