import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import {
  editSummary,
  regenerateSummary,
  sendSummary,
  type AttemptRow,
  type SummaryPayload,
} from './api';

/**
 * Generated text is presented as a DRAFT, never as fact. Nothing reaches a
 * customer without a named human reading it and clicking Send, and the
 * model's original wording is kept immutable next to whatever the human
 * edited, so an audit can always separate the two.
 */
export function SummaryDialog({
  attempt,
  onClose,
  onChanged,
}: {
  attempt: AttemptRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [text, setText] = useState(attempt.final_text ?? attempt.draft_text ?? '');
  const [draft, setDraft] = useState(attempt.draft_text);
  const [source, setSource] = useState(attempt.ai_source);
  const [model, setModel] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alreadySent = attempt.sent_at !== null;
  const isFallback = source === 'template';

  /** Applies whatever the server returned, so the dialog never shows stale text. */
  const apply = (payload: SummaryPayload) => {
    setDraft(payload.draft);
    setSource(payload.source);
    setModel(payload.model);
    setText(payload.finalText ?? payload.draft ?? '');
    setReviewed(false); // new words, so the human has to read them again
  };

  const regenerate = async () => {
    setGenerating(true);
    setError(null);
    try {
      apply(await regenerateSummary(attempt.id));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not regenerate');
    } finally {
      setGenerating(false);
    }
  };

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Customer summary
            {isFallback ? (
              <Badge variant="secondary">Standard message</Badge>
            ) : (
              <Badge variant="warning">AI draft - review before sending</Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {attempt.address}, {attempt.postcode}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="rounded-md bg-muted p-3 text-sm">
            <div className="mb-1 font-medium text-muted-foreground">Driver note</div>
            <div>{attempt.note ?? 'No note recorded'}</div>
          </div>

          {generating ? (
            <div className="rounded-md border border-dashed p-4">
              <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-primary" />
                </span>
                Generating a summary from the driver&apos;s note
              </div>
              {/* Shimmer lines rather than a spinner: it reads as text arriving. */}
              <div className="flex flex-col gap-2">
                <div className="h-3 w-full animate-pulse rounded bg-muted" />
                <div className="h-3 w-4/5 animate-pulse rounded bg-muted [animation-delay:150ms]" />
                <div className="h-3 w-2/3 animate-pulse rounded bg-muted [animation-delay:300ms]" />
              </div>
            </div>
          ) : (
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onFocus={() => setReviewed(true)}
              rows={3}
              maxLength={200}
              disabled={alreadySent}
              placeholder="No summary generated"
            />
          )}

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{text.length}/140 characters</span>
            {model ? <span>- {model.split('.').pop()}</span> : null}
            {!reviewed && !alreadySent && text.length > 0 ? (
              <span className="text-amber-600">Read the text to enable Send</span>
            ) : null}
          </div>

          {draft && text.trim() !== draft.trim() ? (
            <p className="text-xs text-muted-foreground">
              Original AI draft, kept for audit: &ldquo;{draft}&rdquo;
            </p>
          ) : null}

          {alreadySent ? (
            <p className="text-xs text-muted-foreground">
              Sent {new Date(attempt.sent_at as string).toLocaleString()}
            </p>
          ) : null}

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            disabled={busy || generating || alreadySent}
            onClick={() => void regenerate()}
          >
            {generating ? 'Generating...' : 'Regenerate'}
          </Button>
          <Button
            variant="outline"
            disabled={busy || generating || alreadySent || text.trim().length === 0}
            onClick={() => void run(() => editSummary(attempt.id, text.trim()))}
          >
            Save edit
          </Button>
          <Button
            // Send stays disabled until the text has actually been read: the
            // human approval has to be real, not a reflex click.
            disabled={busy || generating || alreadySent || !reviewed || text.trim().length === 0}
            onClick={() =>
              void run(async () => {
                if (text.trim() !== (attempt.final_text ?? draft)) {
                  await editSummary(attempt.id, text.trim());
                }
                await sendSummary(attempt.id);
                onClose();
              })
            }
          >
            {alreadySent ? 'Sent' : 'Approve and send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
