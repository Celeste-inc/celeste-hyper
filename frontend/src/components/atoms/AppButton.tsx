import type { ReactNode } from "react";

interface AppButtonProps {
  children: ReactNode;
  variant?: "primary" | "ghost" | "danger";
  type?: "button" | "submit";
  disabled?: boolean;
  className?: string;
  onClick?: () => void;
}

export function AppButton({ children, variant = "primary", type = "button", disabled = false, className = "", onClick }: AppButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      className={`hyper-button ${variant === "ghost" ? "ghost" : ""} ${variant === "danger" ? "danger" : ""} ${className}`.trim()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
