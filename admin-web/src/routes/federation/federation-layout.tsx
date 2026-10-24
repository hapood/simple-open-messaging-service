import { Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/** Peer list header; peer detail remains a full-page sibling route. */
export function FederationLayout() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">
        {t('federation.title')}
      </h1>
      <Outlet />
    </div>
  );
}
