import type { ReactNode } from 'react';
import { Globe } from 'lucide-react';
import type { MirrorState } from '../../../shared/types';
import { api } from '../../api';
import { Badge } from '../ui/badge';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { ModulePanel } from './shared';
import type { RunAction } from './types';

/** Module natif « Web » : recherche web commune au foyer. */
export function WebSearchSettings({
  state,
  run,
  hidden,
  action,
}: {
  state: MirrorState;
  run: RunAction;
  hidden?: boolean;
  action?: ReactNode;
}) {
  const enabled = state.webSearchEnabled !== false;
  const tavilyEnabled = state.geminiTavilyEnabled !== false;
  return (
    <ModulePanel
      id="module-web"
      icon={Globe}
      title="Web"
      subtitle="Recherche sur le web avec les sources sur la carte"
      badge={
        <Badge variant={enabled ? 'secondary' : 'outline'}>
          {enabled ? 'Activée' : 'Désactivée'}
        </Badge>
      }
      action={action}
      hidden={hidden}
    >
      <p className="text-sm text-muted-foreground">
        Pour l’actualité, les horaires d’un lieu, un prix ou un événement, Cornelius cherche sur le
        web avant de répondre, et le miroir affiche les liens cités. Désactivée, la recherche n’est
        plus proposée : Cornelius dit qu’il ne peut pas vérifier une information récente, sans rien
        inventer. Avec Gemini, choisissez ci-dessous Tavily ou la recherche Google native. La
        recherche native d’OpenAI reste inchangée. Les requêtes de recherche sont transmises au
        service choisi. Les modules (heure, météo, bus, maison) ne passent jamais par le web.
      </p>
      <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
        <div className="space-y-1">
          <Label htmlFor="web-search-enabled">Autoriser la recherche web</Label>
          <p className="text-xs text-muted-foreground">
            Réglage commun au foyer. Une conversation en cours redémarre pour en tenir compte.
          </p>
        </div>
        <Switch
          id="web-search-enabled"
          checked={enabled}
          onCheckedChange={(value) => {
            void run(value ? 'Recherche web activée.' : 'Recherche web désactivée.', () =>
              api.webSearch(value),
            );
          }}
        />
      </div>
      <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
        <div className="space-y-1">
          <Label htmlFor="gemini-tavily-enabled">Utiliser Tavily avec Gemini</Label>
          <p className="text-xs text-muted-foreground">
            Activé : la recherche Gemini passe par Tavily et sa clé API. Désactivé : Gemini utilise
            la recherche Google native, selon les accès et quotas du compte. Ce réglage ne change
            pas OpenAI. Une conversation en cours redémarre pour en tenir compte.
          </p>
        </div>
        <Switch
          id="gemini-tavily-enabled"
          checked={tavilyEnabled}
          onCheckedChange={(value) => {
            void run(
              value
                ? 'Recherche Gemini via Tavily activée.'
                : 'Recherche Google native de Gemini activée.',
              () => api.geminiTavily(value),
            );
          }}
        />
      </div>
    </ModulePanel>
  );
}
