import thema from '@thema';

/**
 * Unterreiter innerhalb einer Seite (Schreibhilfe, Admin) — aktiver Reiter mit dem Unterstrich des Themas
 * (`thema.unterreiterAktiv`).
 */
interface SubTab<K extends string> {
  key: K;
  label: string;
}

interface SubTabsProps<K extends string> {
  tabs: readonly SubTab<K>[];
  active: K;
  onChange: (key: K) => void;
}

export default function SubTabs<K extends string>({ tabs, active, onChange }: SubTabsProps<K>) {
  return (
    <div role="tablist" className="flex flex-wrap gap-1 mb-5 border-b border-gray-200">
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.key)}
            className={`px-3 py-2 text-sm -mb-px border-b-2 rounded-t-[5px] transition-colors ${
              isActive
                ? `${thema.unterreiterAktiv} text-gray-900 font-semibold`
                : 'border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
