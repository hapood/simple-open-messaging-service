import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export interface ReportSection {
  id: string;
  label: string;
  issues?: number;
}

export function SectionNav({ sections }: { sections: ReportSection[] }) {
  const { t } = useTranslation();
  const [active, setActive] = useState(sections[0]?.id);
  useEffect(() => {
    const first = document.getElementById(sections[0]?.id);
    const root = first?.closest('main');
    const update = () => {
      const top = root?.getBoundingClientRect().top ?? 0;
      let current = sections[0]?.id;
      for (const section of sections) {
        const element = document.getElementById(section.id);
        if (element && element.getBoundingClientRect().top <= top + 100)
          current = section.id;
      }
      setActive(current);
    };
    const target = root ?? window;
    target.addEventListener('scroll', update, { passive: true });
    update();
    return () => target.removeEventListener('scroll', update);
  }, [sections]);
  return (
    <nav
      aria-label={t('federation.selfCheck.navigation')}
      className="sticky top-2 z-10 h-fit min-w-0 rounded-xl border bg-background/95 p-2 shadow-sm backdrop-blur xl:top-4 xl:p-3"
    >
      <div className="mb-2 hidden px-2 text-xs font-medium leading-[16px] text-muted-foreground xl:block">
        {t('federation.selfCheck.navigation')}
      </div>
      <ol className="flex gap-1 overflow-x-auto xl:flex-col">
        {sections.map((section, index) => (
          <li key={section.id} className="shrink-0">
            <a
              href={`#${section.id}`}
              aria-current={active === section.id ? 'location' : undefined}
              onClick={(event) => {
                event.preventDefault();
                const element = document.getElementById(section.id);
                element?.scrollIntoView({
                  behavior: window.matchMedia(
                    '(prefers-reduced-motion: reduce)',
                  ).matches
                    ? 'instant'
                    : 'smooth',
                  block: 'start',
                });
                element?.focus({ preventScroll: true });
                setActive(section.id);
              }}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-2 text-xs leading-[18px] transition-colors hover:bg-muted',
                active === section.id &&
                  'bg-primary/10 font-medium text-primary',
              )}
            >
              <span className="font-mono opacity-60">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="flex-1">{section.label}</span>
              {!!section.issues && (
                <span className="rounded bg-amber-500/15 px-1 text-amber-700 dark:text-amber-400">
                  {section.issues}
                </span>
              )}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
