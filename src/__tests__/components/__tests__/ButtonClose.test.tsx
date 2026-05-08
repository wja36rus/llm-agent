import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ButtonClose } from '../../../components/ButtonClose';

describe('ButtonClose Component', () => {
  it('renders button with default text', () => {
    render(<ButtonClose />);
    expect(screen.getByRole('button', { name: /hello!/i })).toBeInTheDocument();
  });

  it('calls onClick handler when clicked', () => {
    const handleClick = jest.fn();
    render(<ButtonClose onClick={handleClick} />);
    
    fireEvent.click(screen.getByRole('button'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('renders button with custom text', () => {
    render(<ButtonClose>Custom Text</ButtonClose>);
    expect(screen.getByRole('button', { name: /custom text/i })).toBeInTheDocument();
  });

  it('renders disabled button', () => {
    render(<ButtonClose disabled />);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('applies custom class name', () => {
    render(<ButtonClose className="custom-class" />);
    expect(screen.getByRole('button')).toHaveClass('btn custom-class');
  });
});