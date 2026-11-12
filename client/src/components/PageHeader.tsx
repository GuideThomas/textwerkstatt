/**
 * Kopf einer Seite: Titel und Untertitel aus dem Thema (`thema.Seitentitel`), Aktionen rechts.
 */
import type { ReactNode } from 'react';
import thema from '@thema';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

export default function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <thema.Seitentitel title={title} subtitle={subtitle} />

      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>
  );
}
