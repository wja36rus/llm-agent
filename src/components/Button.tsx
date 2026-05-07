import React from "react";
import { getCurrentEnd } from "./utils/getCurrentEnd";

interface ButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  onClick,
  disabled = false,
  className = "",
}) => {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`btn ${className}`}
      role="button"
    >
      {children}
      {getCurrentEnd("Hello!")}
    </button>
  );
};
