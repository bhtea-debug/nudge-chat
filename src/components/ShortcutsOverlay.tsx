'use client';

interface Props {
  open: boolean;
  onClose: () => void;
}

const groups: { title: string; items: { keys: string[]; description: string }[] }[] = [
  {
    title: 'Nawigacja',
    items: [
      { keys: ['⌘', 'K'], description: 'Szybki przeskok do kanału / osoby' },
      { keys: ['Esc'],       description: 'Zamknij modal / autocomplete' },
      { keys: ['?'],         description: 'Otwórz tę pomoc' },
    ],
  },
  {
    title: 'Wiadomości',
    items: [
      { keys: ['Enter'],         description: 'Wyślij wiadomość' },
      { keys: ['Shift', 'Enter'],description: 'Nowa linia' },
      { keys: ['@'],             description: 'Wzmiankuj osobę' },
      { keys: [':'],             description: 'Wstaw emoji (np. :smile)' },
      { keys: ['/'],             description: 'Polecenia: /poll, /remind, /me, /shrug' },
    ],
  },
  {
    title: 'Formatowanie (Markdown)',
    items: [
      { keys: ['**tekst**'],  description: 'Pogrubienie' },
      { keys: ['*tekst*'],    description: 'Kursywa' },
      { keys: ['`kod`'],      description: 'Kod inline' },
      { keys: ['```'],        description: 'Blok kodu (między dwoma ```)' },
      { keys: ['> tekst'],    description: 'Cytat' },
      { keys: ['- a, - b'],   description: 'Lista' },
    ],
  },
];

export default function ShortcutsOverlay({ open, onClose }: Props) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-lg bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 max-h-[85vh] flex flex-col">
        <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <h3 className="font-semibold text-slate-900 dark:text-slate-100">Skróty klawiszowe</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin p-5 space-y-5">
          {groups.map(g => (
            <div key={g.title}>
              <h4 className="text-[11px] uppercase tracking-wide font-semibold text-slate-400 dark:text-slate-500 mb-2">{g.title}</h4>
              <div className="space-y-1.5">
                {g.items.map(it => (
                  <div key={it.description} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-slate-700 dark:text-slate-200">{it.description}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      {it.keys.map((k, i) => (
                        <kbd key={i} className="font-mono text-[11px] px-1.5 py-0.5 border border-slate-200 dark:border-slate-700 rounded text-slate-600 dark:text-slate-300">{k}</kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-400 text-center">
          Wpisz <kbd className="font-mono px-1 border border-slate-200 dark:border-slate-700 rounded">/</kbd> w wiadomości aby zobaczyć polecenia
        </div>
      </div>
    </div>
  );
}
