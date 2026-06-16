// Стек снапшотов состояния для undo (глубина до 50 шагов)

const MAX_DEPTH = 50;
const stack = [];

export function push(snapshot) {
  stack.push(snapshot);
  if (stack.length > MAX_DEPTH) stack.shift();
}

export function pop() {
  return stack.pop() || null;
}

export function size() {
  return stack.length;
}

export function clear() {
  stack.length = 0;
}
