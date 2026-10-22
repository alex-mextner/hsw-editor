import type { ReactNode } from 'react';
import { ExternalLinkIcon } from 'lucide-react';
import type { BankElement, BankIndex } from '@hsw-editor/bank';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { formatNumber, formatRange, safeExternalUrl } from './detailModel.ts';
import { PROVENANCE_LABELS, SITE_LABELS, UNIT_LABELS } from './labels.ts';

export function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function Facts({ children }: { readonly children: ReactNode }) {
  return (
    <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      {children}
    </dl>
  );
}

export function Fact({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function ExternalLink({ href, children }: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      {children}
      <ExternalLinkIcon className="size-3" aria-hidden />
    </a>
  );
}

export function ParamsSection({ element }: { readonly element: BankElement }) {
  const { t, locale } = useI18n();
  if (!element.params || element.params.length === 0) return null;
  return (
    <Section title={t('bank.detail.params')}>
      <table className="w-full text-xs">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-1 pr-2 font-normal">{t('bank.detail.paramName')}</th>
            <th className="py-1 pr-2 font-normal">{t('bank.detail.paramRange')}</th>
            <th className="py-1 font-normal">{t('bank.detail.paramDefault')}</th>
          </tr>
        </thead>
        <tbody>
          {element.params.map((param) => {
            const unit = t(UNIT_LABELS[param.unit]);
            return (
              <tr key={param.key} className="border-t border-border align-top">
                <td className="py-1 pr-2">{param.label[locale]}</td>
                <td className="py-1 pr-2 whitespace-nowrap tabular-nums">
                  {formatRange(param, locale)} {unit}
                </td>
                <td className="py-1 whitespace-nowrap tabular-nums">
                  {formatNumber(param.default, locale)} {unit}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}

export function FitsSection({
  element,
  index,
}: {
  readonly element: BankElement;
  readonly index: BankIndex;
}) {
  const { t, locale } = useI18n();
  if (element.fitsTool.length === 0 && element.toolClasses.length === 0) return null;
  const className = (id: string): string =>
    index.toolClasses.find((toolClass) => toolClass.id === id)?.name[locale] ?? id;
  const hinted = new Set(element.fitsTool.map((fit) => fit.toolClass));
  const unhinted = element.toolClasses.filter((id) => !hinted.has(id));
  return (
    <Section title={t('bank.detail.holds')}>
      <ul className="flex flex-col gap-2 text-xs">
        {element.fitsTool.map((fit) => (
          <li key={fit.toolClass} className="rounded-md border border-border bg-card px-2 py-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{className(fit.toolClass)}</span>
              {fit.capacity !== undefined ? (
                <span className="text-muted-foreground">
                  {t('bank.detail.capacity', { count: fit.capacity })}
                </span>
              ) : null}
            </div>
            {fit.dims ? (
              <ul className="mt-1 flex flex-col gap-0.5 text-muted-foreground">
                {Object.entries(fit.dims).map(([key, range]) => (
                  <li key={key} className="flex justify-between gap-2">
                    <span className="font-mono">{key}</span>
                    <span className="tabular-nums">
                      {formatRange(range, locale)} {t('bank.unit.mm')}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {fit.notes ? <p className="mt-1 text-muted-foreground">{fit.notes[locale]}</p> : null}
          </li>
        ))}
      </ul>
      {unhinted.length > 0 ? (
        <p className="text-xs text-muted-foreground">{unhinted.map(className).join(', ')}</p>
      ) : null}
    </Section>
  );
}

export function LicenseSection({ element }: { readonly element: BankElement }) {
  const { t } = useI18n();
  const { license } = element;
  const url = safeExternalUrl(license.url);
  return (
    <Section title={t('bank.detail.license')}>
      <Facts>
        <Fact label={t('bank.detail.spdx')}>
          <span className="font-mono">{license.spdx}</span>
        </Fact>
        <Fact label={t('bank.detail.redistributable')}>
          <span
            className={cn('font-medium', license.redistributable ? 'text-ok' : 'text-destructive')}
          >
            {license.redistributable ? t('bank.yes') : t('bank.no')}
          </span>
        </Fact>
        {license.attribution !== '' ? (
          <Fact label={t('bank.detail.attribution')}>{license.attribution}</Fact>
        ) : null}
        {url ? (
          <Fact label={t('bank.detail.licenseLink')}>
            <ExternalLink href={url}>{new URL(url).hostname}</ExternalLink>
          </Fact>
        ) : null}
      </Facts>
    </Section>
  );
}

export function ProvenanceSection({ element }: { readonly element: BankElement }) {
  const { t, tn } = useI18n();
  const { provenance } = element;
  const { source, generator } = provenance;
  const sourceUrl = safeExternalUrl(source?.url);
  return (
    <Section title={t('bank.detail.provenance')}>
      <Facts>
        <Fact label={t('bank.detail.origin')}>{t(PROVENANCE_LABELS[provenance.origin])}</Fact>
        {source ? (
          <>
            <Fact label={t('bank.detail.site')}>{t(SITE_LABELS[source.site])}</Fact>
            {source.title ? <Fact label={t('bank.detail.sourceTitle')}>{source.title}</Fact> : null}
            {source.author ? <Fact label={t('bank.detail.author')}>{source.author}</Fact> : null}
            {sourceUrl ? (
              <Fact label={t('bank.detail.sourceLink')}>
                <ExternalLink href={sourceUrl}>{new URL(sourceUrl).hostname}</ExternalLink>
              </Fact>
            ) : null}
          </>
        ) : null}
        {generator ? (
          <Fact label={t('bank.detail.generator')}>
            <span className="font-mono">
              {t('bank.detail.generatorValue', {
                generator: generator.generator,
                part: generator.part,
                version: generator.version,
              })}
            </span>
          </Fact>
        ) : null}
      </Facts>
      {provenance.duplicates.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {tn('bank.detail.duplicates', provenance.duplicates.length)}
        </p>
      ) : null}
    </Section>
  );
}

export function PrintNotesSection({ element }: { readonly element: BankElement }) {
  const { t, locale } = useI18n();
  const notes = element.printNotes;
  if (!notes) return null;
  const materials = notes.materials ?? [];
  if (
    materials.length === 0 &&
    !notes.orientation &&
    notes.supports === undefined &&
    !notes.notes
  ) {
    return null;
  }
  return (
    <Section title={t('bank.detail.printNotes')}>
      <Facts>
        {materials.length > 0 ? (
          <Fact label={t('bank.detail.materials')}>{materials.join(', ')}</Fact>
        ) : null}
        {notes.orientation ? (
          <Fact label={t('bank.detail.orientation')}>{notes.orientation[locale]}</Fact>
        ) : null}
        {notes.supports !== undefined ? (
          <Fact label={t('bank.detail.supports')}>
            {notes.supports ? t('bank.yes') : t('bank.no')}
          </Fact>
        ) : null}
        {notes.notes ? <Fact label={t('bank.detail.notes')}>{notes.notes[locale]}</Fact> : null}
      </Facts>
    </Section>
  );
}
