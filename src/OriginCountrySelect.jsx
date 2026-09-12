import { ORIGIN_COUNTRIES, originCountry } from '../server/origin-country.js';

export default function OriginCountrySelect({ value, onChange, emptyLabel = '请选择国家', ariaLabel = '产地国家' }) {
  const selected = originCountry(value) || value || '';
  return <select aria-label={ariaLabel} value={selected} onChange={(event) => onChange(event.target.value)}>
    <option value="">{emptyLabel}</option>
    {selected && !ORIGIN_COUNTRIES.some((country) => country.name === selected) && <option value={selected}>{selected}</option>}
    {ORIGIN_COUNTRIES.map((country) => <option key={country.code} value={country.name}>{country.name}（{country.label}）</option>)}
  </select>;
}
