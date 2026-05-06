interface CahCardProps {
  variant: "black" | "white";
  text: string;
  pick?: number;
  size?: "full" | "hand";
  played?: boolean;
  selected?: boolean;
  onClick?: () => void;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
}

export function CahCard({
  variant,
  text,
  pick,
  size = "full",
  played = false,
  selected = false,
  onClick,
  placeholder,
  className = "",
  style: extraStyle,
}: CahCardProps) {
  const isBlack = variant === "black";
  const isFull = size === "full";

  const w = isFull ? "170px" : "90px";
  const minH = isFull ? "238px" : "126px";
  const fontSize = isFull ? (text.length > 80 ? 12 : 15) : (text.length > 60 ? 8 : 10);
  const padding = isFull ? "16px 14px 12px" : "10px 9px 8px";

  let boxShadow = isBlack
    ? "0 8px 24px rgba(0,0,0,0.8)"
    : "0 4px 14px rgba(0,0,0,0.35)";
  if (played) boxShadow = "0 0 0 2.5px #34d399, 0 4px 14px rgba(52,211,153,0.2)";
  if (selected) boxShadow = "0 0 0 2.5px #a855f7, 0 4px 16px rgba(168,85,247,0.35)";

  const bgColor = isBlack ? "#000" : "#fff";
  const textColor = isBlack ? "#fff" : "#000";
  const logoColor = isBlack ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.28)";
  const logoBg = isBlack ? "#fff" : "#000";
  const logoText = isBlack ? "#000" : "#fff";

  const interactive = !!onClick && !played;

  return (
    <div
      onClick={interactive ? onClick : undefined}
      className={className}
      style={{
        width: w,
        minHeight: minH,
        padding,
        borderRadius: 10,
        background: bgColor,
        color: textColor,
        boxShadow,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
        fontWeight: 800,
        lineHeight: 1.35,
        fontSize,
        flexShrink: 0,
        cursor: interactive ? "pointer" : "default",
        opacity: played ? 0.55 : 1,
        transition: "transform 0.1s, box-shadow 0.1s",
        userSelect: "none",
        ...extraStyle,
      }}
      onMouseEnter={(e) => {
        if (interactive) (e.currentTarget as HTMLElement).style.transform = "translateY(-3px)";
      }}
      onMouseLeave={(e) => {
        if (interactive) (e.currentTarget as HTMLElement).style.transform = "";
      }}
    >
      <div>
        {placeholder && !text ? (
          <span style={{ color: "#94a3b8", fontStyle: "italic", fontWeight: 600, fontSize: 9 }}>
            {placeholder}
          </span>
        ) : (
          text
        )}
      </div>

      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginTop: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
          <div
            style={{
              width: isFull ? 13 : 10,
              height: isFull ? 13 : 10,
              borderRadius: 2,
              background: logoBg,
              color: logoText,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 900,
              fontSize: isFull ? 7 : 6,
            }}
          >
            C
          </div>
          <span style={{ fontWeight: 700, fontSize: isFull ? 6 : 5.5, letterSpacing: 0.2, lineHeight: 1.2, color: logoColor }}>
            Cards Against<br />Bhayanak
          </span>
        </div>
        {isBlack && pick && (
          <span style={{ fontSize: isFull ? 8 : 6.5, fontWeight: 900, textTransform: "uppercase", color: "rgba(255,255,255,0.4)" }}>
            Pick {pick}
          </span>
        )}
      </div>
    </div>
  );
}
