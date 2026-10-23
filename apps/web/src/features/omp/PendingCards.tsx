import { useState, type ReactNode } from 'react';
import { ShieldQuestion, Trash2, MessageCircleQuestion } from 'lucide-react';
import type {
  HswPromptAnswer,
  HswPromptRequest,
  OmpAskQuestion,
  OmpDialogRequest,
  OmpUiResponse,
} from '@hsw-editor/omp-protocol';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { useT, type Translate } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';

function Card({
  icon,
  title,
  children,
  tone = 'neutral',
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <section
      role="alertdialog"
      aria-label={title}
      className={cn(
        'mx-2 mb-2 rounded-lg border p-3 text-sm shadow-sm',
        tone === 'danger'
          ? 'border-destructive/50 bg-destructive/10'
          : 'border-primary/40 bg-muted/60',
      )}
    >
      <header className="mb-2 flex items-center gap-2 font-medium">
        {icon}
        <span>{title}</span>
      </header>
      {children}
    </section>
  );
}

function cancelled(id: string): OmpUiResponse {
  return { type: 'extension_ui_response', id, cancelled: true };
}

function SelectCard({
  request,
  onAnswer,
}: {
  request: Extract<OmpDialogRequest, { method: 'select' }>;
  onAnswer: (r: OmpUiResponse) => void;
}) {
  const t = useT();
  const isApproval = request.options.includes('Approve') && request.options.includes('Deny');
  return (
    <Card
      icon={<ShieldQuestion className="size-4 text-primary" />}
      title={isApproval ? t('omp.dialog.approvalTitle') : request.title}
    >
      {isApproval && <p className="mb-3 break-words text-muted-foreground">{request.title}</p>}
      <div className={cn('flex gap-2', isApproval ? 'flex-row' : 'flex-col')}>
        {request.options.map((option, index) => {
          const description = request.optionDetails?.[index]?.description;
          const label =
            option === 'Approve'
              ? t('omp.dialog.approve')
              : option === 'Deny'
                ? t('omp.dialog.deny')
                : option;
          return (
            <Button
              key={option}
              size="sm"
              variant={
                option === 'Approve' ? 'default' : option === 'Deny' ? 'destructive' : 'outline'
              }
              className={cn(
                !isApproval && 'h-auto justify-start py-1.5 text-left whitespace-normal',
              )}
              onClick={() =>
                onAnswer({ type: 'extension_ui_response', id: request.id, value: option })
              }
            >
              <span>
                {label}
                {description ? (
                  <span className="block text-xs font-normal text-muted-foreground">
                    {description}
                  </span>
                ) : null}
              </span>
            </Button>
          );
        })}
        {!isApproval && (
          <Button size="sm" variant="ghost" onClick={() => onAnswer(cancelled(request.id))}>
            {t('omp.dialog.cancel')}
          </Button>
        )}
      </div>
    </Card>
  );
}

function ConfirmCard({
  request,
  onAnswer,
}: {
  request: Extract<OmpDialogRequest, { method: 'confirm' }>;
  onAnswer: (r: OmpUiResponse) => void;
}) {
  const t = useT();
  return (
    <Card icon={<ShieldQuestion className="size-4 text-primary" />} title={request.title}>
      <p className="mb-3 break-words text-muted-foreground">{request.message}</p>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() =>
            onAnswer({ type: 'extension_ui_response', id: request.id, confirmed: true })
          }
        >
          {t('omp.dialog.yes')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onAnswer({ type: 'extension_ui_response', id: request.id, confirmed: false })
          }
        >
          {t('omp.dialog.no')}
        </Button>
      </div>
    </Card>
  );
}

function TextCard({
  request,
  onAnswer,
}: {
  request: Extract<OmpDialogRequest, { method: 'input' | 'editor' }>;
  onAnswer: (r: OmpUiResponse) => void;
}) {
  const t = useT();
  const [value, setValue] = useState(request.method === 'editor' ? (request.prefill ?? '') : '');
  const submit = (): void => onAnswer({ type: 'extension_ui_response', id: request.id, value });
  return (
    <Card icon={<MessageCircleQuestion className="size-4 text-primary" />} title={request.title}>
      {request.method === 'input' ? (
        <Input
          value={value}
          placeholder={request.placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
        />
      ) : (
        <Textarea rows={4} value={value} onChange={(event) => setValue(event.target.value)} />
      )}
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={submit}>
          {t('omp.dialog.submit')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onAnswer(cancelled(request.id))}>
          {t('omp.dialog.cancel')}
        </Button>
      </div>
    </Card>
  );
}

interface AskState {
  readonly selected: readonly string[];
  readonly custom: string;
}

function AskQuestionView({
  question,
  state,
  onChange,
  t,
}: {
  question: OmpAskQuestion;
  state: AskState;
  onChange: (next: AskState) => void;
  t: Translate;
}) {
  const toggle = (label: string): void => {
    if (question.multi === true) {
      const selected = state.selected.includes(label)
        ? state.selected.filter((entry) => entry !== label)
        : [...state.selected, label];
      onChange({ ...state, selected });
    } else {
      onChange({ selected: state.selected[0] === label ? [] : [label], custom: '' });
    }
  };
  return (
    <fieldset className="mb-3 min-w-0">
      {question.header ? (
        <legend className="text-xs uppercase tracking-wide text-muted-foreground">
          {question.header}
        </legend>
      ) : null}
      <p className="mb-1.5 break-words font-medium">{question.question}</p>
      {question.multi === true ? (
        <p className="mb-1 text-xs text-muted-foreground">{t('omp.dialog.multi')}</p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        {question.options.map((option, index) => {
          const active = state.selected.includes(option.label);
          return (
            <Button
              key={option.label}
              size="sm"
              variant={active ? 'default' : 'outline'}
              aria-pressed={active}
              className="h-auto justify-start py-1.5 text-left whitespace-normal"
              onClick={() => toggle(option.label)}
            >
              <span>
                {option.label}
                {question.recommended === index ? (
                  <span className="ml-1.5 text-xs opacity-70">· {t('omp.dialog.recommended')}</span>
                ) : null}
                {option.description ? (
                  <span className="block text-xs font-normal opacity-70">{option.description}</span>
                ) : null}
                {option.preview ? (
                  <pre className="mt-1 max-h-24 overflow-auto rounded bg-background/60 p-1 text-xs font-normal">
                    {option.preview}
                  </pre>
                ) : null}
              </span>
            </Button>
          );
        })}
        <Input
          value={state.custom}
          placeholder={t('omp.dialog.otherOption')}
          onChange={(event) =>
            onChange({
              selected: question.multi === true ? state.selected : [],
              custom: event.target.value,
            })
          }
        />
      </div>
    </fieldset>
  );
}

function AskCard({
  request,
  onAnswer,
}: {
  request: Extract<OmpDialogRequest, { method: 'ask' }>;
  onAnswer: (r: OmpUiResponse) => void;
}) {
  const t = useT();
  const [states, setStates] = useState<Readonly<Record<string, AskState>>>({});
  const stateOf = (id: string): AskState => states[id] ?? { selected: [], custom: '' };
  const complete = request.questions.every((question) => {
    const state = stateOf(question.id);
    return question.multi === true || state.selected.length > 0 || state.custom.trim().length > 0;
  });
  const submit = (): void =>
    onAnswer({
      type: 'extension_ui_response',
      id: request.id,
      answers: request.questions.map((question) => {
        const state = stateOf(question.id);
        const custom = state.custom.trim();
        return {
          id: question.id,
          selectedOptions: [...state.selected],
          ...(custom.length > 0 ? { customInput: custom } : {}),
        };
      }),
    });
  return (
    <Card
      icon={<MessageCircleQuestion className="size-4 text-primary" />}
      title={t('omp.dialog.question')}
    >
      {request.questions.map((question) => (
        <AskQuestionView
          key={question.id}
          question={question}
          state={stateOf(question.id)}
          t={t}
          onChange={(next) => setStates({ ...states, [question.id]: next })}
        />
      ))}
      <div className="flex gap-2">
        <Button size="sm" disabled={!complete} onClick={submit}>
          {t('omp.dialog.submit')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onAnswer(cancelled(request.id))}>
          {t('omp.dialog.cancel')}
        </Button>
      </div>
    </Card>
  );
}

/** A dialog omp is blocked on. */
export function DialogCard({
  request,
  onAnswer,
}: {
  request: OmpDialogRequest;
  onAnswer: (response: OmpUiResponse) => void;
}) {
  switch (request.method) {
    case 'select':
      return <SelectCard request={request} onAnswer={onAnswer} />;
    case 'confirm':
      return <ConfirmCard request={request} onAnswer={onAnswer} />;
    case 'input':
    case 'editor':
      return <TextCard request={request} onAnswer={onAnswer} />;
    case 'ask':
      return <AskCard request={request} onAnswer={onAnswer} />;
  }
}

/** An approval raised by the wall tools themselves (destructive agent edits). */
export function WallPromptCard({
  request,
  onAnswer,
}: {
  request: HswPromptRequest;
  onAnswer: (answer: HswPromptAnswer) => void;
}) {
  const t = useT();
  return (
    <Card
      icon={<Trash2 className="size-4 text-destructive" />}
      title={t('omp.prompt.destructive')}
      tone="danger"
    >
      <p className="mb-1 font-medium">{request.title}</p>
      <p className="mb-3 break-words text-muted-foreground">{request.summary}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="destructive" onClick={() => onAnswer({ approved: true })}>
          {t('omp.prompt.allow')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onAnswer({ approved: false })}>
          {t('omp.prompt.decline')}
        </Button>
      </div>
    </Card>
  );
}
