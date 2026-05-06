interface CahCardProps {
  variant: "black" | "white";
  text: string;
  pick?: number;
  size?: "full" | "hand";
  played?: boolean;
  selected?: boolean;
  winner?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  placeholder?: string;
  className?: string;
}

export function CahCard({
  variant,
  text,
  pick,
  size = "full",
  played = false,
  selected = false,
  winner = false,
  disabled = false,
  onClick,
  placeholder,
  className = "",
}: CahCardProps) {
  const isBlack = variant === "black";
  const isFull = size === "full";

  const interactive = !!onClick && !played;

  const sizeClass = isFull
    ? "w-[170px] min-h-[238px] pt-4 px-[14px] pb-3"
    : "w-[90px] min-h-[126px] pt-[10px] px-[9px] pb-2";

  const fontSizeClass = isFull
    ? text.length > 80 ? "text-[12px]" : "text-[15px]"
    : text.length > 60 ? "text-[8px]" : "text-[10px]";

  const shadowClass = winner
    ? "shadow-[0_0_0_2.5px_#facc15,0_0_20px_rgba(250,204,21,0.4)]"
    : played
    ? "shadow-[0_0_0_2.5px_#34d399,0_4px_14px_rgba(52,211,153,0.2)]"
    : selected
    ? "shadow-[0_0_0_2.5px_#a855f7,0_4px_16px_rgba(168,85,247,0.35)]"
    : isBlack
    ? "shadow-[0_8px_24px_rgba(0,0,0,0.8)]"
    : "shadow-[0_4px_14px_rgba(0,0,0,0.35)]";

  const logoSquareSize = isFull ? "w-[13px] h-[13px] text-[7px]" : "w-[10px] h-[10px] text-[6px]";
  const logoTextSize = isFull ? "text-[6px]" : "text-[5.5px]";
  const pickTextSize = isFull ? "text-[8px]" : "text-[6.5px]";

  return (
    <div
      onClick={interactive ? onClick : undefined}
      className={[
        "flex flex-col justify-between font-card font-extrabold leading-[1.35] shrink-0 rounded-[10px] select-none transition-[transform,box-shadow] duration-100",
        sizeClass,
        fontSizeClass,
        shadowClass,
        isBlack ? "bg-black text-white" : "bg-white text-black",
        interactive ? "cursor-pointer hover:-translate-y-[3px]" : "cursor-default",
        played ? "opacity-55" : "opacity-100",
        disabled ? "opacity-40" : "",
        className,
      ].join(" ")}
    >
      <div>
        {placeholder && !text ? (
          <span className="text-slate-400 italic font-semibold text-[9px]">{placeholder}</span>
        ) : (
          text
        )}
      </div>

      <div className="flex items-end justify-between mt-2">
        <div className="flex items-center gap-[3px]">
          <div
            className={[
              "rounded-[2px] flex items-center justify-center font-black",
              logoSquareSize,
              isBlack ? "bg-white text-black" : "bg-black text-white",
            ].join(" ")}
          >
            C
          </div>
          <span
            className={[
              "font-bold leading-[1.2] tracking-[0.2px]",
              logoTextSize,
              isBlack ? "text-white/35" : "text-black/28",
            ].join(" ")}
          >
            Cards Against<br />Bhayanak
          </span>
        </div>

        {isBlack && pick && (
          <span className={`${pickTextSize} font-black uppercase ${isBlack ? "text-white/40" : ""}`}>
            Pick {pick}
          </span>
        )}
      </div>
    </div>
  );
}
