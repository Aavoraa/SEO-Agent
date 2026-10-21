import { Link } from 'react-router-dom';
import { PlugZap } from 'lucide-react';
import type { DataLabelValue } from '../api/types';
import { Pill, type Tone } from './Badges';

const LABELS: Record<DataLabelValue, { text: string; tone: Tone; title: string }> = {
  verified: { text: 'Verified', tone: 'green', title: 'First-party data: your Search Console, Analytics or our crawler' },
  estimated: { text: 'Estimated', tone: 'amber', title: 'Third-party estimate from a data provider' },
  modeled: { text: 'Modeled', tone: 'blue', title: 'Calculated by Phoenixx from labelled inputs' },
  unavailable: { text: 'Unavailable', tone: 'gray', title: 'The data provider is not connected' },
  demo: { text: 'Demo', tone: 'violet', title: 'Sample data – demo mode' },
};

/** Where a number comes from. Every provider-backed metric shows one. */
export function DataLabel({ label }: { label: DataLabelValue }) {
  const l = LABELS[label];
  return (
    <Pill tone={l.tone} title={l.title}>
      {l.text}
    </Pill>
  );
}

/** Shown instead of numbers when the provider behind a feature isn't connected. */
export function IntegrationRequired({ what, provider, phase }: { what: string; provider: string; phase?: number }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-3">
      <PlugZap className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
      <div className="text-sm">
        <div className="font-medium text-gray-900">Integration required{phase ? ` · planned for phase ${phase}` : ''}</div>
        <div className="text-gray-600">
          {what} needs {provider}. No numbers are shown until it is connected. <Link to="/integrations" className="font-medium text-brand-700 hover:underline">See integrations</Link>
        </div>
      </div>
    </div>
  );
}
