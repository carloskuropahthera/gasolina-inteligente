'use client';
import { useState, useCallback } from 'react';

const STORAGE_KEY = 'gi_user_stats_v1';

interface UserStatsData {
  points: number;
  badge: string;
}

function computeBadge(points: number): string {
  if (points >= 200) return '🔥 Experto';
  if (points >= 50)  return '⛽ Regular';
  return '🌱 Nuevo';
}

function readStats(): UserStatsData {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as { points?: number } | null;
    const points = raw?.points ?? 0;
    return { points, badge: computeBadge(points) };
  } catch {
    return { points: 0, badge: computeBadge(0) };
  }
}

export function useUserStats() {
  const [stats, setStats] = useState<UserStatsData>(() => {
    if (typeof window === 'undefined') return { points: 0, badge: computeBadge(0) };
    return readStats();
  });

  const addPoints = useCallback((n: number) => {
    setStats(prev => {
      const next = prev.points + n;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ points: next })); } catch { /* ignore */ }
      return { points: next, badge: computeBadge(next) };
    });
  }, []);

  return { stats, addPoints };
}
