'use client'

import { useState, useTransition } from 'react'
import { saveOptimizationSettings } from './actions'
import type { OptimizationSettings } from '@/lib/titleOptimizationService'

export function SettingsPanel({
  feedId,
  initialSettings,
}: {
  feedId: string
  initialSettings: OptimizationSettings
}) {
  const [charLimit, setCharLimit] = useState(String(initialSettings.charLimit))
  const [fewShot, setFewShot] = useState(initialSettings.fewShotExamples)
  const [model, setModel] = useState(initialSettings.model ?? '')
  const [temperature, setTemperature] = useState(
    initialSettings.temperature === null ? '' : String(initialSettings.temperature)
  )

  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const exampleCount = fewShot.split('\n').filter((l) => l.trim()).length

  function handleSave() {
    setError(null)
    setSuccess(false)

    const limit = parseInt(charLimit, 10)
    if (!Number.isFinite(limit) || limit < 1) {
      setError('Character limit must be a positive whole number')
      return
    }
    let temp: number | null = null
    if (temperature.trim() !== '') {
      temp = parseFloat(temperature)
      if (!Number.isFinite(temp) || temp < 0 || temp > 1) {
        setError('Temperature must be between 0 and 1')
        return
      }
    }

    startTransition(async () => {
      const result = await saveOptimizationSettings(feedId, {
        charLimit: limit,
        fewShotExamples: fewShot,
        model: model.trim() === '' ? null : model.trim(),
        temperature: temp,
      })
      if (result.error) setError(result.error)
      else {
        setSuccess(true)
        setTimeout(() => setSuccess(false), 3000)
      }
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-2">
        {error && (
          <span style={{ fontSize: '11px', color: 'var(--color-badge-danger-text)' }}>{error}</span>
        )}
        <button onClick={handleSave} disabled={isPending} className="ff-btn-primary">
          {isPending ? 'Saving…' : success ? 'Saved' : 'Save settings'}
        </button>
      </div>

      {/* Few-shot examples */}
      <div className="ff-panel">
        <div
          className="ff-panel-header"
          style={{ textTransform: 'none', letterSpacing: 0, fontSize: '12px', padding: '10px 14px' }}
        >
          Title examples
        </div>
        <div className="p-3.5 space-y-2">
          <p style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
            5–10 hand-written “perfect” titles for the catalogue, one per line. They set the structure and
            tone of every generated title and matter most for quality.
            Write them in the feed’s market language.
          </p>
          <textarea
            value={fewShot}
            onChange={(e) => setFewShot(e.target.value)}
            rows={10}
            spellCheck={false}
            placeholder={'- Brand Product type Key attributes Variant\n- Villa Antinori Chianti Classico 1970 Rotwein\n- …'}
            className="ff-input w-full"
            style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', lineHeight: 1.6, resize: 'vertical' }}
          />
          <p style={{ fontSize: '10px', color: 'var(--color-text-tertiary)' }}>
            {exampleCount.toLocaleString('en-GB')} {exampleCount === 1 ? 'example' : 'examples'}
            {exampleCount > 0 && exampleCount < 5 ? '. Aim for at least 5' : ''}
          </p>
        </div>
      </div>

      {/* Limits + model */}
      <div className="ff-panel">
        <div
          className="ff-panel-header"
          style={{ textTransform: 'none', letterSpacing: 0, fontSize: '12px', padding: '10px 14px' }}
        >
          Limits and model
        </div>
        <div className="p-3.5 space-y-3">
          <div>
            <label className="ff-label">Character limit</label>
            <input
              type="number"
              min={1}
              value={charLimit}
              onChange={(e) => setCharLimit(e.target.value)}
              className="ff-input w-32"
            />
            <p className="mt-1" style={{ fontSize: '10px', color: 'var(--color-text-tertiary)' }}>
              Google Merchant Center allows at most 150. Longer titles are sent for manual review.
            </p>
          </div>

          <div className="flex gap-4">
            <div>
              <label className="ff-label">Model (optional)</label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="claude-haiku-4-5"
                className="ff-input w-56"
              />
            </div>
            <div>
              <label className="ff-label">Temperature (optional)</label>
              <input
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                placeholder="0.3"
                className="ff-input w-28"
              />
            </div>
          </div>
          <p style={{ fontSize: '10px', color: 'var(--color-text-tertiary)' }}>
            Leave the fields empty for the defaults (claude-haiku-4-5, temperature 0.3). Temperature
            only works on models that support it.
          </p>
        </div>
      </div>
    </div>
  )
}
