import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { cx } from '../lib/format';

export function EmptyState({ title, description, action, icon, compact }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode; compact?: boolean }) {
  return (
    <div className={cx('flex flex-col items-center justify-center rounded-lg border border-dashed border-gray-300 bg-white text-center', compact ? 'px-4 py-6' : 'px-6 py-12')}>
      <div className="mb-2 text-gray-400">{icon ?? <Inbox className="h-6 w-6" />}</div>
      <p className="text-sm font-medium text-gray-800">{title}</p>
      {description && <p className="mt-1 max-w-md text-sm text-gray-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
