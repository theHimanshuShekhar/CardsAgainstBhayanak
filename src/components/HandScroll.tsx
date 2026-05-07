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
    <div className="relative overflow-hidden">
      {showChevron && (
        <>
          <div className="absolute top-0 right-0 w-16 h-full bg-gradient-to-r from-transparent to-[#0d1a33] pointer-events-none z-10" />
          <div className="absolute right-2.5 top-[50%] z-20 text-violet-400/85 text-xl pointer-events-none animate-cab-chevron">
            ›
          </div>
        </>
      )}

      <div
        ref={scrollRef}
        className="flex gap-2 overflow-x-auto pb-1 scrollbar-none"
      >
        {cards.map((card) => (
          <CahCard
            key={card.id}
            variant="white"
            text={card.text}
            size="hand"
            played={playedIds.has(card.id)}
            disabled={disabled}
            onClick={disabled || playedIds.has(card.id) ? undefined : () => onPlay(card.id)}
            testId="hand-card"
          />
        ))}
      </div>
    </div>
  );
}
