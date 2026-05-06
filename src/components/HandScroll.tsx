import { useRef, useState, useEffect } from "react";
import { CahCard } from "./CahCard";

interface HandCard {
  id: string;
  text: string;
}

interface HandScrollProps {
  cards: HandCard[];
  playedIds: Set<string>;
  disabled: boolean;
  onPlay: (cardId: string) => void;
}

export function HandScroll({ cards, playedIds, disabled, onPlay }: HandScrollProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showChevron, setShowChevron] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    function check() {
      if (!el) return;
      setShowChevron(el.scrollLeft + el.clientWidth < el.scrollWidth - 8);
    }

    el.addEventListener("scroll", check, { passive: true });
    check();
    return () => el.removeEventListener("scroll", check);
  }, [cards]);

  return (
    <div style={{ position: "relative", overflow: "hidden" }}>
      {showChevron && (
        <>
          <div style={{
            position: "absolute", top: 0, right: 0,
            width: 64, height: "100%",
            background: "linear-gradient(to right, transparent, #0d1a33)",
            pointerEvents: "none", zIndex: 2,
          }} />
          <div style={{
            position: "absolute", right: 10, top: "50%",
            transform: "translateY(-50%)", zIndex: 3,
            color: "rgba(167,139,250,0.85)", fontSize: 20,
            pointerEvents: "none",
            animation: "cabChevron 1.6s ease-in-out infinite",
          }}>
            ›
          </div>
        </>
      )}

      <div
        ref={scrollRef}
        style={{
          display: "flex",
          gap: 8,
          overflowX: "auto",
          paddingBottom: 4,
          scrollbarWidth: "none",
          msOverflowStyle: "none",
        } as React.CSSProperties}
      >
        {cards.map((card) => (
          <CahCard
            key={card.id}
            variant="white"
            text={card.text}
            size="hand"
            played={playedIds.has(card.id)}
            onClick={disabled || playedIds.has(card.id) ? undefined : () => onPlay(card.id)}
            style={{ opacity: disabled ? 0.4 : 1 } as React.CSSProperties}
          />
        ))}
      </div>

      <style>{`
        @keyframes cabChevron {
          0%, 100% { opacity: 0.5; transform: translateY(-50%) translateX(0); }
          50%       { opacity: 1;   transform: translateY(-50%) translateX(4px); }
        }
        div::-webkit-scrollbar { display: none; }
      `}</style>
    </div>
  );
}
