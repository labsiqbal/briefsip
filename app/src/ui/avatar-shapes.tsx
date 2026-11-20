import { RadioGroup, Toast } from 'radix-ui';
import { createRoot } from 'react-dom/client';
import { Check } from 'lucide-react';
import { Button } from './kit';
import './avatar.css';

// Original Minarbot silhouettes. No upstream avatar paths or assets are used.
export const AVATAR_SHAPES = [
  { name: 'Pebble', path: 'M23 28C37 13 68 16 80 34C94 55 84 80 63 85C42 91 17 78 15 58C13 46 15 37 23 28Z' },
  { name: 'Sprout', path: 'M46 29C28 31 21 18 25 10C42 9 52 16 52 28C65 24 79 33 83 48C90 70 76 87 51 88C27 89 14 73 19 52C22 39 31 31 46 29Z' },
  { name: 'Bunny', path: 'M25 41L23 16C22 4 36 3 39 15L45 36L55 36L61 15C64 3 78 4 77 16L75 41C94 59 84 88 50 89C16 88 6 59 25 41Z' },
  { name: 'Mochi', path: 'M14 59C15 34 30 22 50 22C70 22 85 34 86 59L89 72C91 82 82 88 74 83C67 89 58 90 50 85C42 90 33 89 26 83C18 88 9 82 11 72Z' },
  { name: 'Finch', path: 'M22 39C24 20 45 13 61 22C68 26 72 32 74 39C83 38 89 42 92 49L78 56C79 74 64 86 46 85C25 84 12 69 14 52L7 41C11 34 17 34 22 39Z' },
  { name: 'Cloudlet', path: 'M22 41C12 25 32 12 44 24C55 8 77 19 73 34C96 34 99 58 82 66C86 86 62 94 50 80C37 97 15 85 20 69C1 66 4 43 22 41Z' },
  { name: 'Dumpling', path: 'M14 65C17 53 30 41 38 27C44 16 56 16 62 27C70 41 83 53 86 65C92 87 8 87 14 65Z' },
  { name: 'Cub', path: 'M22 38C5 31 15 9 30 18L37 25C45 22 55 22 63 25L70 18C85 9 95 31 78 38C93 61 80 86 50 87C20 86 7 61 22 38Z' },
  { name: 'Lantern', path: 'M38 19C38 9 62 9 62 19L62 26C83 30 90 48 83 65L74 81C71 88 58 90 50 85C42 90 29 88 26 81L17 65C10 48 17 30 38 26Z' },
  { name: 'Scoop', path: 'M25 39C17 27 30 15 41 22C48 11 65 15 67 27C83 22 91 40 79 49C90 58 86 75 73 77L66 87C61 92 54 88 50 83C46 88 39 92 34 87L27 77C14 75 10 58 21 49C17 46 18 41 25 39Z' },
  { name: 'Ray', path: 'M40 27C43 10 57 10 60 27L64 35L82 33C95 33 96 47 84 52L74 58L77 76C79 88 66 93 58 82L50 75L42 82C34 93 21 88 23 76L26 58L16 52C4 47 5 33 18 33L36 35Z' },
  { name: 'Tadpole', path: 'M19 44C29 25 58 18 75 34C94 51 86 78 64 83C50 87 37 81 29 73C21 79 9 78 6 71C18 65 10 59 19 44Z' },
  { name: 'Mitten', path: 'M30 33C30 12 51 11 53 28C58 9 77 16 72 35C94 25 99 46 81 55L78 73C75 91 30 93 24 76L11 57C4 44 19 35 28 48Z' },
  { name: 'Bell', path: 'M21 58C22 32 33 17 50 17C67 17 78 32 79 58L89 70C94 80 80 85 69 80C58 91 42 91 31 80C20 85 6 80 11 70Z' },
  { name: 'Acorn', path: 'M46 21L45 12C45 6 55 6 55 12L54 21C71 22 83 32 84 43C86 49 81 53 76 52L72 69C67 80 56 87 50 90C44 87 33 80 28 69L24 52C19 53 14 49 16 43C17 32 29 22 46 21Z' },
  { name: 'Squiggle', path: 'M29 27C41 16 62 18 72 28C83 38 74 45 80 53C98 71 78 92 61 81C55 93 35 90 33 78C12 85 2 65 17 53C7 42 16 25 29 27Z' },
] as const;

// 35% white mixed into the light brand/bot tokens; fixed across themes so saved PNGs match previews.
export const AVATAR_COLORS = [
  { name: 'Indigo', fill: '#8D91E6' }, { name: 'Rose', fill: '#FB7BBC' },
  { name: 'Blue', fill: '#6DB0FD' }, { name: 'Orange', fill: '#FE9E63' },
  { name: 'Gold', fill: '#F9B967' }, { name: 'Green', fill: '#66D7A1' },
  { name: 'Teal', fill: '#66D0C3' }, { name: 'Violet', fill: '#B693FB' },
  { name: 'Clay', fill: '#C19F7E' }, { name: 'Silver', fill: '#BDBDBD' },
] as const;
export type AvatarLook = { shape: number; color: number };
const eyeFill = '#1C1C1C';
const eyes = 'M43 49a3.5 3.5 0 0 0-7 0v5a3.5 3.5 0 0 0 7 0ZM64 49a3.5 3.5 0 0 0-7 0v5a3.5 3.5 0 0 0 7 0Z';
function parts(look: AvatarLook) {
  const shape = AVATAR_SHAPES[look.shape], color = AVATAR_COLORS[look.color];
  if (!shape || !color) throw new Error('Choose an available avatar shape and color.');
  return { shape, color };
}
export function MascotAvatar({ look, size = 64 }: { look: AvatarLook; size?: number }) {
  const { shape, color } = parts(look);
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width={size} height={size} aria-hidden="true"><path d={shape.path} fill={color.fill} /><path d={eyes} fill={eyeFill} /></svg>;
}
export async function avatarPng(look: AvatarLook): Promise<string> {
  const { shape, color } = parts(look);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="256" height="256"><path d="${shape.path}" fill="${color.fill}"/><path d="${eyes}" fill="${eyeFill}"/></svg>`;
  const image = new Image(); image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Avatar could not render. Try uploading an image instead.');
  context.drawImage(image, 0, 0, 256, 256);
  return canvas.toDataURL('image/png').split(',')[1];
}
export function AvatarPicker({ name = '', value, onChange, disabled = false }: { name?: string; value: AvatarLook | null; onChange: (look: AvatarLook | null) => void; disabled?: boolean }) {
  const color = value?.color ?? 0;
  return <div className="k-avatar-picker bs-root">
    <div className="k-avatar-picker__head">
      <div className="k-avatar-picker__preview" role="img" aria-label={value ? `${AVATAR_COLORS[color].name} ${AVATAR_SHAPES[value.shape].name} preview` : 'Initials avatar preview'}>{value ? <MascotAvatar look={value} size={76} /> : <span className="bs-avatar" aria-hidden="true">{name.trim().slice(0, 1).toUpperCase() || '?'}</span>}</div>
      <div className="k-avatar-picker__intro"><span className="k-field__label">Choose a look <span className="k-field__optional">Optional</span></span><span className="k-field__hint">Pick a shape and color, or keep initials.</span>{value && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(null)}>Clear choice</Button>}</div>
    </div>
    <RadioGroup.Root className="k-avatar-picker__shapes" aria-label="Avatar shape" value={value ? String(value.shape) : ''} disabled={disabled} orientation="horizontal" onValueChange={shape => onChange({ shape: Number(shape), color })} loop>
      {AVATAR_SHAPES.map((shape, index) => <RadioGroup.Item key={shape.name} className="k-avatar-picker__shape" value={String(index)} aria-label={shape.name} title={shape.name}><MascotAvatar look={{ shape: index, color }} size={42} /><RadioGroup.Indicator className="k-avatar-picker__check"><Check size={10} aria-hidden /></RadioGroup.Indicator></RadioGroup.Item>)}
    </RadioGroup.Root>
    <RadioGroup.Root className="k-avatar-picker__colors" aria-label="Avatar color" value={String(color)} disabled={disabled} onValueChange={next => onChange({ shape: value?.shape ?? 0, color: Number(next) })} orientation="horizontal" loop>
      {AVATAR_COLORS.map((swatch, index) => <RadioGroup.Item key={swatch.name} className="k-avatar-picker__swatch" value={String(index)} aria-label={swatch.name} title={swatch.name}><span style={{ background: swatch.fill }}><RadioGroup.Indicator><Check size={14} color={eyeFill} aria-hidden /></RadioGroup.Indicator></span></RadioGroup.Item>)}
    </RadioGroup.Root>
  </div>;
}

export function notifyAvatarFailure() {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  root.render(<Toast.Provider><Toast.Root defaultOpen duration={12000} type="foreground" className="k-avatar-toast bs-root" onOpenChange={open => { if (!open) queueMicrotask(() => { root.unmount(); host.remove(); }); }}>
    <Toast.Title className="k-field__label">Agent created</Toast.Title>
    <Toast.Description>Avatar could not save. Open Edit profile to try again.</Toast.Description>
    <Toast.Close asChild><Button size="sm">Dismiss</Button></Toast.Close>
  </Toast.Root><Toast.Viewport className="k-avatar-toast-viewport" /></Toast.Provider>);
}
