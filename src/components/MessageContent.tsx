'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

// Match the @[Display Name](userId) syntax stored by the message API.
const MENTION_RE = /@\[([^\]]+)\]\(([^)]+)\)/g;

// Permit our custom `mention:` URL scheme through the sanitizer so we can carry
// the user id from server-stored mentions into a render-time chip.
const sanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [...((defaultSchema.protocols?.href as string[]) ?? []), 'mention'],
  },
};

interface Props {
  content: string;
  isOwn?: boolean;
}

export default function MessageContent({ content, isOwn }: Props) {
  // Rewrite mention syntax to a markdown link with our custom scheme; the
  // anchor renderer below detects this scheme and renders a chip instead.
  const transformed = content.replace(
    MENTION_RE,
    (_, name: string, id: string) => `[@${name}](mention:${id})`,
  );

  return (
    <div className="message-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith('mention:')) {
              return (
                <span
                  className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-[0.92em] font-medium align-baseline ${
                    isOwn
                      ? 'bg-white/25 text-white'
                      : 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-200'
                  }`}
                >
                  {children}
                </span>
              );
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className={`underline underline-offset-2 break-words ${
                  isOwn ? 'text-white hover:opacity-90' : 'text-indigo-600 hover:text-indigo-700 dark:text-indigo-300'
                }`}
              >
                {children}
              </a>
            );
          },
          code: ({ className, children }) => {
            const text = String(children);
            const isBlock = !!className || text.includes('\n');
            if (isBlock) {
              return (
                <pre
                  className={`my-1.5 p-2.5 rounded-lg text-[0.85em] overflow-x-auto font-mono ${
                    isOwn
                      ? 'bg-black/25 text-white'
                      : 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100'
                  }`}
                >
                  <code>{children}</code>
                </pre>
              );
            }
            return (
              <code
                className={`px-1 py-0.5 rounded text-[0.88em] font-mono ${
                  isOwn ? 'bg-black/25 text-white' : 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200'
                }`}
              >
                {children}
              </code>
            );
          },
          p: ({ children }) => <p className="leading-relaxed whitespace-pre-wrap m-0">{children}</p>,
          ul: ({ children }) => <ul className="list-disc ml-5 my-1 space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal ml-5 my-1 space-y-0.5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote
              className={`border-l-2 pl-2 my-1 italic ${
                isOwn ? 'border-white/50' : 'border-slate-300 text-slate-600 dark:border-slate-600 dark:text-slate-300'
              }`}
            >
              {children}
            </blockquote>
          ),
          h1: ({ children }) => <p className="font-bold text-base my-1">{children}</p>,
          h2: ({ children }) => <p className="font-bold my-1">{children}</p>,
          h3: ({ children }) => <p className="font-semibold my-1">{children}</p>,
          hr: () => (
            <hr className={`my-2 ${isOwn ? 'border-white/30' : 'border-slate-200 dark:border-slate-700'}`} />
          ),
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          del: ({ children }) => <del className="opacity-70">{children}</del>,
        }}
      >
        {transformed}
      </ReactMarkdown>
    </div>
  );
}
