'use client';
import { useState, useEffect, useCallback } from 'react';
import type { FuelType } from './types';

const LS_KEY = 'gi_price_alerts_v1';

export interface PriceAlert {
  stationId: string;
  stationName: string;
  fuelType: FuelType;
  threshold: number; // alert when price drops BELOW this
  createdAt: string;
}

function load(): PriceAlert[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function save(alerts: PriceAlert[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(alerts)); } catch { /* storage full */ }
}

export function usePriceAlerts() {
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);

  useEffect(() => { setAlerts(load()); }, []);

  const addAlert = useCallback((alert: PriceAlert) => {
    setAlerts(prev => {
      // Replace existing alert for same station+fuel
      const filtered = prev.filter(a => !(a.stationId === alert.stationId && a.fuelType === alert.fuelType));
      const next = [...filtered, alert];
      save(next);
      return next;
    });
  }, []);

  const removeAlert = useCallback((stationId: string, fuelType: FuelType) => {
    setAlerts(prev => {
      const next = prev.filter(a => !(a.stationId === stationId && a.fuelType === fuelType));
      save(next);
      return next;
    });
  }, []);

  const getAlert = useCallback(
    (stationId: string, fuelType: FuelType) =>
      alerts.find(a => a.stationId === stationId && a.fuelType === fuelType) ?? null,
    [alerts]
  );

  return { alerts, addAlert, removeAlert, getAlert };
}
