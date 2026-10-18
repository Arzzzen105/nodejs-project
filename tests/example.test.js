import { describe, it, expect, vi } from 'vitest';

describe('Базові перевірки тестового рушія', () => {
  it('повинен правильно додавати числа', () => {
    const sum = 2 + 2;
    expect(sum).toBe(4);
  });

  it('повинен повертати Infinity при діленні на нуль', () => {
    const result = 10 / 0;
    expect(result).toBe(Infinity);
  });

  it('повинен знаходити підрядок у тексті', () => {
    const message = 'Hello, World!';
    expect(message).toContain('World');
  });

  it('повинен містити певний елемент у масиві', () => {
    const frameworks = ['express', 'nest', 'koa'];
    expect(frameworks).toContain('express');
  });

  it('повинен успішно викликати mock функцію', () => {
    const mockFunction = vi.fn(); 
    
    mockFunction('test argument'); 
    
    expect(mockFunction).toHaveBeenCalledWith('test argument'); 
  });
});