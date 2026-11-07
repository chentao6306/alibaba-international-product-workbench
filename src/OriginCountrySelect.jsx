import { useId } from 'react';
import { ORIGIN_COUNTRIES, originCountry } from '../server/origin-country.js';

export default function OriginCountrySelect({ value, onChange, emptyLabel = '请选择国家', ariaLabel = '产地国家', allowSourceText = false }) {
  const listId = useId();
  const selected = originCountry(value) || value || '';
  if (allowSourceText) return <><input aria-label={ariaLabel} list={listId} value={value || ''}
    placeholder="选择国家或填写来源原文" onChange={(event) => onChange(event.target.value)} />
    <datalist id={listId}>{ORIGIN_COUNTRIES.map((country) => <option key={country.code} value={country.name}>{country.label}</option>)}</datalist></>;
  return <select aria-label={ariaLabel} value={selected} onChange={(event) => onChange(event.target.value)}>
    <option value="">{emptyLabel}</option>
    {selected && !ORIGIN_COUNTRIES.some((country) => country.name === selected) && <option value={selected}>{selected}</option>}
    {ORIGIN_COUNTRIES.map((country) => <option key={country.code} value={country.name}>{country.name}（{country.label}）</option>)}
  </select>;
}
