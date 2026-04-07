import { useEffect, useState, type RefObject } from 'react';

const DISMISS_THRESHOLD = 80; // px downward swipe to dismiss

export function useSwipeToDismiss(
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
) {
  const [dragY,      setDragY]      = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let startY = 0;

    const onTouchStart = (e: TouchEvent) => {
      // Only activate on mobile breakpoint
      if (window.innerWidth >= 640) return;
      startY = e.touches[0].clientY;
      setIsDragging(true);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!isDragging || window.innerWidth >= 640) return;
      const delta = Math.max(0, e.touches[0].clientY - startY);
      setDragY(delta);
    };

    const onTouchEnd = () => {
      if (!isDragging) return;
      setIsDragging(false);
      if (dragY >= DISMISS_THRESHOLD) {
        setDragY(0);
        onDismiss();
      } else {
        setDragY(0);
      }
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove',  onTouchMove,  { passive: true });
    el.addEventListener('touchend',   onTouchEnd,   { passive: true });

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove',  onTouchMove);
      el.removeEventListener('touchend',   onTouchEnd);
    };
  }, [ref, onDismiss, isDragging, dragY]);

  return { dragY, isDragging };
}
