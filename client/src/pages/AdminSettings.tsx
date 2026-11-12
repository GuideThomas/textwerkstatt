import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../hooks/useAuth';
import UserManagement from '../components/UserManagement';
import TopicManagement from '../components/TopicManagement';
import NativeSpeakerManagement from '../components/NativeSpeakerManagement';
import PageHeader from '../components/PageHeader';
import SubTabs from '../components/SubTabs';
import PanelConnectionsPage from './PanelConnectionsPage';
import KiAnbindung from '../components/KiAnbindung';
import Schutzregeln from '../components/textwerkstatt/Schutzregeln';
import Optimierungsarten from '../components/textwerkstatt/Optimierungsarten';
import Stilprofile from '../components/textwerkstatt/Stilprofile';

type AdminView = 'users' | 'topics' | 'speakers' | 'panel' | 'ki' | 'schutz' | 'arten' | 'stil' | 'system';

export default function AdminSettings() {
  const { user } = useAuth();
  const { t } = useTranslation('admin');
  // Vier Bereiche als Unterreiter statt einer 3.100 px langen Seite (22.10.2026).
  const [view, setView] = useState<AdminView>('users');

  if (user?.role !== 'admin') {
    return (
      <div className="text-center py-20 text-gray-500 text-sm">
        {t('access.adminOnly')}
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={t('page.title')} subtitle={t('page.subtitle')} />
      <SubTabs
        tabs={[
          { key: 'users', label: t('users.title') },
          { key: 'topics', label: t('topics.title', { ns: 'glossary' }) },
          { key: 'speakers', label: t('speakers.title') },
          { key: 'panel', label: t('connections.adminTitle', { ns: 'panel' }) },
          { key: 'ki', label: t('verwaltung.titel', { ns: 'ki' }) },
          { key: 'schutz', label: t('verwaltung.titel', { ns: 'pseudonym' }) },
          { key: 'arten', label: t('arten.titel', { ns: 'textwerkstatt' }) },
          { key: 'stil', label: t('stil.titel', { ns: 'textwerkstatt' }) },
          { key: 'system', label: t('system.title') },
        ] as const}
        active={view}
        onChange={setView}
      />

      {view === 'users' && (
        <div className="card card-content">
          <UserManagement />
        </div>
      )}

      {view === 'topics' && (
        <div className="card card-content">
          <TopicManagement />
        </div>
      )}

      {view === 'speakers' && (
        <div className="card card-content">
          <NativeSpeakerManagement />
        </div>
      )}

      {view === 'panel' && (
        <div className="card card-content">
          <PanelConnectionsPage all />
        </div>
      )}

      {view === 'ki' && (
        <div className="card card-content">
          <KiAnbindung />
        </div>
      )}

      {view === 'schutz' && (
        <div className="card card-content">
          <Schutzregeln />
        </div>
      )}

      {view === 'arten' && (
        <div className="card card-content">
          <Optimierungsarten />
        </div>
      )}

      {view === 'stil' && (
        <div className="card card-content">
          <Stilprofile />
        </div>
      )}

      {view === 'system' && (
        <div className="space-y-6">
          <div className="card card-content">
            <h3 className="text-sm font-semibold text-gray-800 mb-4">{t('system.title')}</h3>
            <div className="space-y-3 text-sm">
              <InfoRow label={t('system.auth')} value="Microsoft SSO (Azure AD)" />
              <InfoRow label={t('system.llmPrimary')} value="DeepSeek V3.2 (via LiteLLM)" />
              <InfoRow label={t('system.llmFallback')} value="Gemini 2.5 Flash (via LiteLLM)" />
              <InfoRow label="DeepL" value={t('system.deeplValue')} />
              <InfoRow label={t('system.condensingThreshold')} value={t('system.condensingValue', { pct: 115 })} />
              <InfoRow label={t('system.pdfExtraction')} value="Docling (Port 5001)" />
              <InfoRow label={t('system.maxFileSize')} value="100 MB" />
              <InfoRow label={t('system.fileRetention')} value={t('system.fileRetentionValue')} />
            </div>
          </div>

          <div className="card card-content">
            <h3 className="text-sm font-semibold text-gray-800 mb-4">{t('formats.title')}</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <FormatBadge format="IDML" desc="InDesign" />
              <FormatBadge format="DOCX" desc="Word" />
              <FormatBadge format="XLSX" desc="Excel" />
              <FormatBadge format="PDF" desc={t('formats.viaDocling')} />
            </div>
          </div>

          <div className="card card-content">
            <h3 className="text-sm font-semibold text-gray-800 mb-4">{t('prices.title')}</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b">
                    <th className="py-2 pr-4">{t('prices.model')}</th>
                    <th className="py-2 pr-4 text-right">{t('prices.input')}</th>
                    <th className="py-2 text-right">{t('prices.output')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-gray-50">
                    <td className="py-2 pr-4 font-mono text-xs">deepseek/deepseek-chat</td>
                    <td className="py-2 pr-4 text-right">$0.28</td>
                    <td className="py-2 text-right">$0.42</td>
                  </tr>
                  <tr className="border-b border-gray-50">
                    <td className="py-2 pr-4 font-mono text-xs">gemini/gemini-2.5-flash</td>
                    <td className="py-2 pr-4 text-right">$0.15</td>
                    <td className="py-2 text-right">$0.60</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1.5 border-b border-gray-50">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-900 font-medium">{value}</span>
    </div>
  );
}

function FormatBadge({ format, desc }: { format: string; desc: string }) {
  return (
    <div className="border border-gray-200 rounded-[5px] p-3 text-center">
      <div className="font-semibold text-gray-900">{format}</div>
      <div className="text-xs text-gray-500">{desc}</div>
    </div>
  );
}
