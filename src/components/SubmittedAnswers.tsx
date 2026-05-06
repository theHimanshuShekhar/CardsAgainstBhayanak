import { CahCard } from "./CahCard";

interface Submission {
  submissionId: string;
  cards: Array<{ id: number; text: string }>;
  playerName?: string;
}

interface SubmittedAnswersProps {
  submissions: Submission[];
  isCzar: boolean;
  winningSubmissionId: string | null;
  pendingPlayers: string[];
  onPick?: (submissionId: string) => void;
}

export function SubmittedAnswers({
  submissions,
  isCzar,
  winningSubmissionId,
  pendingPlayers,
  onPick,
}: SubmittedAnswersProps) {
  return (
    <div>
      <p className="text-[10px] text-slate-600 uppercase tracking-[2px] mb-2">
        {isCzar ? "Pick the winner" : "Submitted answers"}
      </p>

      <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(140px,1fr))]">
        {submissions.map((sub) => {
          const isWinner = sub.submissionId === winningSubmissionId;
          return (
            <div key={sub.submissionId} className="flex flex-col gap-1">
              {sub.cards.map((card, i) => (
                <CahCard
                  key={`${sub.submissionId}-${i}`}
                  variant="white"
                  text={card.text}
                  size="full"
                  selected={isCzar && !winningSubmissionId}
                  winner={isWinner}
                  onClick={isCzar && !winningSubmissionId ? () => onPick?.(sub.submissionId) : undefined}
                />
              ))}
              {isWinner && sub.playerName && (
                <p className="text-center text-yellow-400 text-xs font-bold">
                  {sub.playerName} 🏆
                </p>
              )}
            </div>
          );
        })}

        {pendingPlayers.map((name) => (
          <CahCard
            key={`pending-${name}`}
            variant="white"
            text=""
            size="full"
            placeholder={`${name} thinking…`}
          />
        ))}
      </div>
    </div>
  );
}
