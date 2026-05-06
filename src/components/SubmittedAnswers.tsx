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
      <p style={{ fontSize: 10, color: "#475569", textTransform: "uppercase", letterSpacing: 2, marginBottom: 8 }}>
        {isCzar ? "Pick the winner" : "Submitted answers"}
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8 }}>
        {submissions.map((sub) => {
          const isWinner = sub.submissionId === winningSubmissionId;
          return (
            <div key={sub.submissionId} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {sub.cards.map((card, i) => (
                <CahCard
                  key={`${sub.submissionId}-${i}`}
                  variant="white"
                  text={card.text}
                  size="full"
                  selected={isCzar && !winningSubmissionId}
                  onClick={isCzar && !winningSubmissionId ? () => onPick?.(sub.submissionId) : undefined}
                  style={isWinner ? {
                    boxShadow: "0 0 0 2.5px #facc15, 0 0 20px rgba(250,204,21,0.4)",
                  } : undefined}
                />
              ))}
              {isWinner && sub.playerName && (
                <p style={{ textAlign: "center", color: "#facc15", fontSize: 12, fontWeight: 700 }}>
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
