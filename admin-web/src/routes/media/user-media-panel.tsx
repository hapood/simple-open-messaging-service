import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { MediaFilesPanel, MediaUploadsPanel } from './media-tables';

/** User-scoped views share the global catalog and upload operations, not independent implementations. */
export function UserMediaPanel({ userId }: { userId: number }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'files' | 'uploads'>('files');
  return (
    <section className="flex flex-col gap-3 leading-[20px]">
      <div className="flex gap-2">
        <Button
          variant={tab === 'files' ? 'default' : 'outline'}
          onClick={() => setTab('files')}
        >
          {t('media.filesTitle')}
        </Button>
        <Button
          variant={tab === 'uploads' ? 'default' : 'outline'}
          onClick={() => setTab('uploads')}
        >
          {t('media.uploadsTitle')}
        </Button>
      </div>
      {tab === 'files' ? (
        <MediaFilesPanel key={userId} userId={userId} />
      ) : (
        <MediaUploadsPanel key={userId} userId={userId} />
      )}
    </section>
  );
}
