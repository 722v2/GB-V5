import { useState, useEffect } from 'react';
import { X, Server, Activity, Clock, Database, Copy, Check, ShieldCheck, AlertCircle, Radio } from 'lucide-react';

interface WorkerInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const WorkerInfoModal = ({ isOpen, onClose }: WorkerInfoModalProps) => {
  const [health, setHealth] = useState<any>(null);
  const [copied, setCopied] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const fetchHealth = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        const data = await res.json();
        setHealth(data);
      }
    } catch (e) {
      console.error('Failed to fetch health data:', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchHealth();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const cronUrl = `${origin}/api/scanner/cron-tick`;

  const handleCopyUrl = () => {
    navigator.clipboard.writeText(cronUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-xs">
      <div className="bg-stone-900 border border-stone-800 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-stone-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
              <Server className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-stone-100 flex items-center gap-2">
                <span>معمارية الخادم والمسح المباشر 24/7</span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  Autonomous Worker
                </span>
              </h2>
              <p className="text-[11px] text-stone-400">
                حالة الخادم وتفاصيل تشغيل الماسح بشكل مستقل عن المتصفح والجهاز
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-stone-400 hover:text-stone-200 hover:bg-stone-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1 text-xs">
          {/* Health Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            {/* Status */}
            <div className="bg-stone-950/70 border border-stone-800 rounded-xl p-3">
              <span className="text-[10px] text-stone-500 block uppercase font-mono">Scanner Status</span>
              <div className="flex items-center gap-1.5 mt-1">
                <span className={`w-2 h-2 rounded-full ${health?.scannerStatus === 'ONLINE' ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`} />
                <span className="font-bold text-stone-200 font-mono">{health?.scannerStatus || 'ONLINE'}</span>
              </div>
            </div>

            {/* Worker Uptime */}
            <div className="bg-stone-950/70 border border-stone-800 rounded-xl p-3">
              <span className="text-[10px] text-stone-500 block uppercase font-mono">Worker Uptime</span>
              <span className="font-bold text-amber-400 font-mono mt-1 block">
                {health?.workerUptimeFormatted || '0s'}
              </span>
            </div>

            {/* Biquote Connection */}
            <div className="bg-stone-950/70 border border-stone-800 rounded-xl p-3">
              <span className="text-[10px] text-stone-500 block uppercase font-mono">Biquote Feed</span>
              <span className="font-bold text-emerald-400 font-mono mt-1 block truncate">
                {health?.biquoteConnection?.includes('CONNECTED') ? 'CONNECTED (MT5)' : health?.biquoteConnection || 'CONNECTED'}
              </span>
            </div>

            {/* Last Scan Time */}
            <div className="bg-stone-950/70 border border-stone-800 rounded-xl p-3">
              <span className="text-[10px] text-stone-500 block uppercase font-mono">Last Scan Time</span>
              <span className="font-bold text-stone-200 font-mono mt-1 block">
                {health?.lastScanTimeFormatted || 'N/A'}
              </span>
            </div>

            {/* Next Scan Time */}
            <div className="bg-stone-950/70 border border-stone-800 rounded-xl p-3">
              <span className="text-[10px] text-stone-500 block uppercase font-mono">Next Scan Time</span>
              <span className="font-bold text-cyan-400 font-mono mt-1 block">
                {health?.nextScanTimeFormatted || 'N/A'}
              </span>
            </div>

            {/* Scans Run */}
            <div className="bg-stone-950/70 border border-stone-800 rounded-xl p-3">
              <span className="text-[10px] text-stone-500 block uppercase font-mono">Total Scans Run</span>
              <span className="font-bold text-stone-200 font-mono mt-1 block">
                {health?.scanCount || 0}
              </span>
            </div>
          </div>

          {/* Deployment Environment Disclosure (Requirement 11) */}
          <div className="bg-stone-950/90 border border-amber-500/30 rounded-xl p-4 space-y-2 text-stone-300">
            <div className="flex items-center gap-2 text-amber-400 font-bold text-xs">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>توضيح بيئة الاستضافة السحابية (Deployment Reality):</span>
            </div>
            <p className="text-[11px] text-stone-400 leading-relaxed">
              يعمل الماسح كـ <strong>خادم خلفي مستقل في Node.js</strong> داخل الحاوية السحابية، ويفحص سوق الذهب تلقائياً كل 60 ثانية ويسجل النتائج في التخزين الدائم دون الاعتماد على المتصفح أو شاشة الهاتف.
            </p>
            <p className="text-[11px] text-stone-400 leading-relaxed">
              ومع ذلك، فإن بيئات الحاويات السحابية مثل <strong>Cloud Run</strong> بطبيعتها قد تدخل في وضع السكون (Scale-to-Zero) عند انعدام الطلبات الخارجية تماماً لفترة طويلة.
            </p>
          </div>

          {/* Solution 1: External Cron Webhook */}
          <div className="bg-stone-950/60 border border-stone-800 rounded-xl p-3.5 space-y-2">
            <div className="flex items-center gap-2 text-stone-200 font-semibold">
              <Radio className="w-4 h-4 text-emerald-400" />
              <span>الحل 1: رابط الـ Webhook الخارجي (موصى به للعمل المستمر):</span>
            </div>
            <p className="text-[11px] text-stone-400">
              قم بضبط أي خدمة مجانية لفحص الروابط (مثل <strong>cron-job.org</strong> أو <strong>UptimeRobot</strong> أو <strong>Google Cloud Scheduler</strong>) لإرسال طلب GET أو POST إلى الرابط التالي كل 60 ثانية (مع ترويسة <code>Authorization: Bearer CRON_SECRET</code> أو إضافة <code>?secret=YOUR_CRON_SECRET</code> إذا تم تعيينه في الخادم):
            </p>
            <div className="flex items-center gap-2 bg-stone-900 border border-stone-700/80 rounded-lg p-2 font-mono text-[11px] text-amber-300">
              <span className="truncate flex-1">{cronUrl}</span>
              <button
                onClick={handleCopyUrl}
                className="px-2.5 py-1 rounded bg-stone-800 hover:bg-stone-700 text-stone-200 text-xs font-sans flex items-center gap-1 shrink-0 transition-colors"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'تم النسخ' : 'نسخ الرابط'}</span>
              </button>
            </div>
            <span className="text-[10px] text-stone-500 block">
              هذا الرابط يوقظ الخادم فوراً، ينفذ الفحص، يمنع التكرار، ويحفظ النتيجة في التخزين الدائم. (يتطلب مصادقة CRON_SECRET عند التفعيل لحماية الخادم).
            </span>
          </div>

          {/* Solution 2: Standalone Worker */}
          <div className="bg-stone-950/60 border border-stone-800 rounded-xl p-3.5 space-y-2">
            <div className="flex items-center gap-2 text-stone-200 font-semibold">
              <Server className="w-4 h-4 text-cyan-400" />
              <span>الحل 2: تشغيل الـ Daemon على أي سيرفر VPS خاص:</span>
            </div>
            <p className="text-[11px] text-stone-400">
              تم بناء معمارية مستقلة بالكامل في ملف <code className="text-amber-300 bg-stone-900 px-1 py-0.5 rounded">server/standaloneWorker.ts</code>. يمكنك تشغيلها على أي VPS (Ubuntu/Debian) عبر الأمر:
            </p>
            <pre className="bg-stone-900 border border-stone-800 p-2 rounded text-[11px] font-mono text-emerald-300">
              npm run worker
            </pre>
            <span className="text-[10px] text-stone-500 block">
              يعمل بنسبة 100% 24/7 دون أي متصفح أو خادم ويب، وبنفس شروط واستراتيجية الذهب الصارمة.
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-stone-800 bg-stone-950/80 flex items-center justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-stone-800 hover:bg-stone-700 text-stone-200 font-semibold"
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
};
