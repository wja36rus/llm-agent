import React from "react";
import { getCurrentEnd } from "./utils/getCurrentEnd";

interface ButtonCloseProps {
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}

export const ButtonClose: React.FC<ButtonCloseProps> = ({
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
      {getCurrentEnd("Hello!")}
    </button>
  );
};
