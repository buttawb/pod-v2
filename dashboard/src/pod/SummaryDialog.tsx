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
import { editSummary, regenerateSummary, sendSummary, type AttemptRow } from './api';

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
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alreadySent = attempt.sent_at !== null;
  const isFallback = attempt.ai_source === 'template';

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

          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setReviewed(true)}
            rows={3}
            maxLength={200}
            disabled={alreadySent}
            placeholder="No summary generated"
          />

          {attempt.draft_text && attempt.final_text && attempt.final_text !== attempt.draft_text ? (
            <p className="text-xs text-muted-foreground">
              Original AI draft, kept for audit: &ldquo;{attempt.draft_text}&rdquo;
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
            disabled={busy || alreadySent}
            onClick={() => void run(() => regenerateSummary(attempt.id))}
          >
            Regenerate
          </Button>
          <Button
            variant="outline"
            disabled={busy || alreadySent || text.trim().length === 0}
            onClick={() => void run(() => editSummary(attempt.id, text.trim()))}
          >
            Save edit
          </Button>
          <Button
            // Send stays disabled until the text has actually been read: the
            // human approval has to be real, not a reflex click.
            disabled={busy || alreadySent || !reviewed || text.trim().length === 0}
            onClick={() =>
              void run(async () => {
                if (text.trim() !== (attempt.final_text ?? attempt.draft_text)) {
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
