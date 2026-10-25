import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserCameraConfig } from '../shared/camera';
import type { DevicesStatus, ServerEvent, StateEvent } from '../shared/types';
import { api, errorMessage, type Role } from './api';

import { audioPreparation, subscribeAudioPreparation } from './audio/preparation';

type AuthenticationStatus = 'valid' | 'expired' | 'unavailable';
// Identifie cette page : une reconnexion du même miroir garde sa conversation en cours.
// randomUUID n’existe qu’en contexte sécurisé ; l’administration peut être ouverte en HTTP local.
const pageId =
  globalThis.crypto?.randomUUID?.() ??
  Date.now().toString(36) + Math.random().toString(36).slice(2);

export function useMirror(role: Role) {
  const [event, setEvent] = useState<StateEvent | null>(null);
  const [online, setOnline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authenticationExpired, setAuthenticationExpired] = useState(false);
  const [cameraConfig, setCameraConfig] = useState<BrowserCameraConfig | null>(null);
  const [devices, setDevices] = useState<DevicesStatus | null>(null);
  const latest = useRef<StateEvent | null>(null);
  const receivedAt = useRef(0);
  const serverOffset = useRef(0);
  const alive = useRef(true);
  const resyncing = useRef(false);
  const expired = useRef(false);
  const checkingAuthentication = useRef<Promise<AuthenticationStatus> | null>(null);
  const closedReason = useRef<string | null>(null);
  const [synchronized, setSynchronized] = useState(false);
  // Fermeture voulue par le serveur (1008), par exemple un autre onglet du miroir : aucune
  // reprise automatique, seulement à la demande (reconnect).
  const [interrupted, setInterrupted] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // /api/state accepte aussi l'autre rôle : vérifier explicitement celui de cet écran.
  const checkAuthentication = useCallback((): Promise<AuthenticationStatus> => {
    if (checkingAuthentication.current) return checkingAuthentication.current;
    checkingAuthentication.current = (async (): Promise<AuthenticationStatus> => {
      try {
        const authentication = await api.auth(role);
        if (!alive.current) return 'unavailable';
        if (authentication.role === role) return 'valid';
        expired.current = true;
        setAuthenticationExpired(true);
        setOnline(false);
        setSynchronized(false);
        setEvent(null);
        latest.current = null;
        return 'expired';
      } catch {
        // Une panne réseau ne prouve pas que la session a expiré.
        return 'unavailable';
      } finally {
        checkingAuthentication.current = null;
      }
    })();
    return checkingAuthentication.current;
  }, [role]);

  const accept = useCallback((snapshot: StateEvent) => {
    if (
      !alive.current ||
      expired.current ||
      closedReason.current ||
      snapshot.type !== 'state' ||
      snapshot.schemaVersion !== 1
    )
      return;
    const previous = latest.current;
    if (previous?.bootId === snapshot.bootId && snapshot.sequence < previous.sequence) return;
    latest.current = snapshot;
    receivedAt.current = Date.now();
    serverOffset.current = snapshot.sentAt - receivedAt.current;
    if (previous?.bootId !== snapshot.bootId || previous.sequence !== snapshot.sequence) {
      if (previous?.bootId === snapshot.bootId) {
        // Preserve unchanged branches for memoized cards and controls.
        for (const key of Object.keys(snapshot.state) as (keyof StateEvent['state'])[]) {
          if (JSON.stringify(previous.state[key]) === JSON.stringify(snapshot.state[key]))
            Object.assign(snapshot.state, { [key]: previous.state[key] });
        }
      }
      setEvent(snapshot);
    }
    setSynchronized(true);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    if (resyncing.current || expired.current) return;
    resyncing.current = true;
    try {
      accept(await api.state());
    } catch (failure) {
      if (alive.current && !closedReason.current) setError(errorMessage(failure));
      await checkAuthentication();
    } finally {
      resyncing.current = false;
    }
  }, [accept, checkAuthentication]);

  useEffect(() => {
    alive.current = true;
    closedReason.current = null;
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let retryMs = 500;
    let interrupted = false;
    const sendMediaReady = () => {
      if (role === 'kiosk' && socket?.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({ type: 'media_ready', ready: audioPreparation().ready, page: pageId }),
        );
    };
    const unsubscribeAudio = subscribeAudioPreparation(sendMediaReady);
    const stopped = () => disposed || expired.current;
    const scheduleReconnect = (verifyAuthentication: boolean) => {
      if (stopped() || interrupted) return;
      reconnectTimer = setTimeout(() => {
        void connect(verifyAuthentication);
      }, retryMs);
      retryMs = Math.min(retryMs * 2, 8_000);
    };
    const connect = async (verifyAuthentication = false) => {
      if (stopped() || interrupted) return;
      if (verifyAuthentication) {
        const authentication = await checkAuthentication();
        if (stopped()) return;
        if (authentication !== 'valid') {
          scheduleReconnect(true);
          return;
        }
      }
      const currentSocket = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/events?role=${role}`,
      );
      socket = currentSocket;
      currentSocket.onopen = () => {
        if (stopped()) return;
        setOnline(true);
        sendMediaReady();
        retryMs = 500;
      };
      currentSocket.onmessage = ({ data }) => {
        if (stopped()) return;
        try {
          const message = JSON.parse(String(data)) as ServerEvent;
          if (message.schemaVersion !== 1) return;
          if (message.type === 'camera_config') {
            if (role === 'kiosk') setCameraConfig(message);
            return;
          }
          if (message.type === 'devices') {
            if (role === 'admin') setDevices(message.status);
            return;
          }
          if (message.type === 'heartbeat') {
            const previous = latest.current;
            if (
              !previous ||
              previous.bootId !== message.bootId ||
              previous.sequence !== message.sequence
            ) {
              setSynchronized(false);
              void refresh();
            } else {
              receivedAt.current = Date.now();
              serverOffset.current = message.sentAt - receivedAt.current;
              setSynchronized(true);
            }
            return;
          }
          if (message.type !== 'state') return;
          const snapshot = message;
          const previous = latest.current;
          if (
            previous &&
            (previous.bootId !== snapshot.bootId || snapshot.sequence > previous.sequence + 1)
          ) {
            setSynchronized(false);
            void refresh();
            return;
          }
          accept(snapshot);
        } catch {
          setSynchronized(false);
          void refresh();
        }
      };
      currentSocket.onclose = (closeEvent) => {
        if (stopped()) return;
        setOnline(false);
        setSynchronized(false);
        if (closeEvent.code === 1008) {
          // Un autre onglet du miroir peut avoir pris la main avec une session encore valide.
          interrupted = true;
          closedReason.current =
            closeEvent.reason || 'Connexion interrompue. Reconnectez ce navigateur.';
          setError(closedReason.current);
          setInterrupted(true);
        }
        const recover = async () => {
          const authentication = await checkAuthentication();
          if (stopped()) return;
          if (interrupted) {
            // Si le serveur est momentanément absent, réessayer seulement l'authentification.
            if (authentication === 'unavailable') {
              reconnectTimer = setTimeout(() => {
                void recover();
              }, retryMs);
              retryMs = Math.min(retryMs * 2, 8_000);
            }
            return;
          }
          scheduleReconnect(authentication !== 'valid');
        };
        void recover();
      };
      currentSocket.onerror = () => currentSocket.close();
    };
    void connect();
    const tick = setInterval(() => {
      if (stopped() || interrupted || socket?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - receivedAt.current > 5_000) {
        setSynchronized(false);
        void refresh();
      }
    }, 1_000);
    return () => {
      disposed = true;
      alive.current = false;
      unsubscribeAudio();
      clearInterval(tick);
      clearTimeout(reconnectTimer);
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
      }
    };
  }, [accept, attempt, checkAuthentication, refresh, role]);

  /** Reprend la main après une interruption : l’autre onglet sera interrompu à son tour. */
  const reconnect = useCallback(() => {
    closedReason.current = null;
    setError(null);
    setInterrupted(false);
    setAttempt((value) => value + 1);
  }, []);

  return {
    event,
    state: event?.state ?? null,
    online,
    fresh: synchronized && online,
    devices,
    cameraConfig,
    error,
    interrupted,
    reconnect,
    authenticationExpired,
    now: Date.now() + serverOffset.current,
    accept,
    refresh,
  };
}

export type MirrorConnection = ReturnType<typeof useMirror>;
