import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import VuePdfEmbed from 'vue-pdf-embed';
import GenerationPreview from '../src/components/GenerationPreview.vue';
import { api } from '../src/api/client';
import type { GenerationJob } from '../src/api/types';

vi.mock('vue-pdf-embed', () => ({
  default: {
    props: ['source', 'width'],
    template:
      '<div :data-pdf-source="source"><slot v-for="page in 3" name="before-page" :page="page" /></div>',
  },
}));

vi.mock('../src/api/client', () => ({ api: vi.fn() }));
const apiMock = vi.mocked(api);
let wrapper: VueWrapper | undefined;
let current: GenerationJob;
let pdfError = false;
const makeJob = (status: GenerationJob['status']): GenerationJob => ({
  id: 'job',
  templateId: 'letter',
  templateName: 'Letter',
  status,
  timestamp: '2026-11-13T00:00:00Z',
  message:
    status === 'failed'
      ? 'Could not generate PDF. Check the template or contact the administrator.'
      : 'PDF generated',
  pdfFilename: status === 'ok' ? 'result.pdf' : null,
});
beforeEach(() => {
  vi.useFakeTimers();
  current = makeJob('queued');
  pdfError = false;
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:preview');
      static revokeObjectURL = vi.fn();
    },
  );
  apiMock.mockReset();
  apiMock.mockImplementation(async (path) => {
    if (path.endsWith('/pdf')) {
      if (pdfError) throw new Error('PDF preview unavailable');
      return new Blob(['%PDF'], { type: 'application/pdf' });
    }
    return { job: current };
  });
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function open(job: GenerationJob | null = null) {
  wrapper = mount(GenerationPreview, {
    props: { job, showPreview: true, submitting: false, error: '' },
  });
  await flushPromises();
}
const bar = () => wrapper!.get('[aria-label="Generation status"]');
it('starts with a neutral Ready bar, no information, and a disabled icon download', async () => {
  await open();
  expect(
    wrapper!
      .get('[aria-label="Document preview"]')
      .find('[aria-label="Generation status"]')
      .exists(),
  ).toBe(true);
  expect(bar().attributes('data-state')).toBe('ready');
  expect(bar().text()).toBe('Ready');
  expect(wrapper!.find('.fa-info').exists()).toBe(false);
  expect(
    wrapper!.get('button[aria-label="Download PDF"]').attributes('disabled'),
  ).toBeDefined();
  expect(wrapper!.find('.fa-download').exists()).toBe(true);
  expect(apiMock).not.toHaveBeenCalled();
});
it('shows Generating with the daisyUI spinner during submission and queued/generating polls', async () => {
  await open();
  await wrapper!.setProps({ submitting: true });
  expect(bar().text()).toContain('Generating...');
  expect(bar().find('.loading.loading-spinner').exists()).toBe(true);
  wrapper!.unmount();
  wrapper = undefined;
  await open(current);
  expect(bar().attributes('data-state')).toBe('generating');
  current = makeJob('generating');
  await vi.advanceTimersByTimeAsync(2000);
  await flushPromises();
  expect(bar().find('.loading-spinner').exists()).toBe(true);
});
it('shows a green Generated bar, timestamp information, icon download, and only the PDF viewer below', async () => {
  current = makeJob('ok');
  await open(current);
  expect(bar().attributes('data-state')).toBe('generated');
  expect(bar().find('.fa-check').exists()).toBe(true);
  expect(bar().get('a[aria-label="Download PDF"]').attributes('href')).toBe(
    '/api/jobs/job/pdf',
  );
  const info = bar().get('button[aria-label="Generation information"]');
  await info.trigger('focus');
  expect(bar().get('[role=tooltip]').isVisible()).toBe(true);
  expect(bar().get('[role=tooltip]').text()).toContain(
    'Generation succeeded for document submitted at',
  );
  expect(bar().get('[role=tooltip]').text()).toContain(
    new Date(current.timestamp).toLocaleString(),
  );
  await info.trigger('keydown', { key: 'Escape' });
  expect(info.attributes('aria-expanded')).toBe('false');
  expect(bar().get('[role=tooltip]').attributes('style')).toContain(
    'display: none',
  );
  expect(wrapper!.get('[data-pdf-source]').attributes('data-pdf-source')).toBe(
    'blob:preview',
  );
  expect(wrapper!.text()).not.toContain('Submitted ');
});
it('zooms the rendered PDF without fetching it again', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private notify: ResizeObserverCallback) {}
      observe() {
        this.notify(
          [{ contentRect: { width: 400 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      disconnect() {}
    },
  );
  current = makeJob('ok');
  await open(current);
  const pdf = wrapper!.getComponent(VuePdfEmbed);
  const zoomIn = bar().get('button[aria-label="Zoom in"]');
  const zoomOut = bar().get('button[aria-label="Zoom out"]');
  const percentage = bar().get('output[aria-label="Zoom level"]');
  expect(zoomOut.element.nextElementSibling).toBe(percentage.element);
  expect(percentage.element.nextElementSibling).toBe(zoomIn.element);
  expect(percentage.text()).toBe('100%');
  expect(pdf.props('width')).toBe(400);
  const calls = apiMock.mock.calls.length;
  await zoomIn.trigger('click');
  expect(pdf.props('width')).toBe(500);
  expect(percentage.text()).toBe('125%');
  await zoomOut.trigger('click');
  expect(pdf.props('width')).toBe(400);
  for (let step = 0; step < 2; step += 1) await zoomOut.trigger('click');
  expect(pdf.props('width')).toBe(200);
  expect(pdf.attributes('style')).toContain('width: 200px');
  expect(pdf.classes()).toContain('mx-auto');
  expect(percentage.text()).toBe('50%');
  expect(zoomOut.attributes('disabled')).toBeUndefined();
  await zoomOut.trigger('click');
  expect(pdf.props('width')).toBe(100);
  expect(percentage.text()).toBe('25%');
  expect(zoomOut.attributes('disabled')).toBeDefined();
  for (let step = 0; step < 7; step += 1) await zoomIn.trigger('click');
  expect(pdf.props('width')).toBe(800);
  expect(zoomIn.attributes('disabled')).toBeDefined();
  expect(apiMock).toHaveBeenCalledTimes(calls);
});

it('shows the page count and navigates by page number or scrolling', async () => {
  current = makeJob('ok');
  await open(current);
  const pdf = wrapper!.getComponent(VuePdfEmbed);
  pdf.vm.$emit('loaded', { numPages: 3 });
  pdf.vm.$emit('rendered');
  await wrapper!.vm.$nextTick();

  const input = bar().get<HTMLInputElement>('input[aria-label="Current page"]');
  expect(input.element.value).toBe('1');
  expect(input.element.nextElementSibling?.textContent).toBe('of 3');
  const markers = pdf.findAll('[data-pdf-page]');
  const viewport = pdf.element.parentElement!.parentElement!;
  Object.defineProperties(viewport, {
    scrollHeight: { value: 1500 },
    clientHeight: { value: 400 },
  });
  markers.forEach((marker, index) => {
    vi.spyOn(marker.element, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, 500 * index - viewport.scrollTop, 0, 0),
    );
  });

  input.element.value = '3';
  await input.trigger('keydown', { key: 'Enter' });
  expect(viewport.scrollTop).toBe(1000);
  await input.setValue('9');
  expect(input.element.value).toBe('3');
  viewport.scrollTop = 550;
  viewport.dispatchEvent(new Event('scroll'));
  await wrapper!.vm.$nextTick();
  expect(input.element.value).toBe('2');
});

it('keeps hover details open while crossing the toolbar and closes them when leaving it', async () => {
  current = makeJob('ok');
  await open(current);
  const info = bar().get('button[aria-label="Generation information"]');
  await info.trigger('mouseenter');
  await bar().get('span.inline-flex').trigger('mouseleave');
  expect(info.attributes('aria-expanded')).toBe('true');
  await bar().trigger('mouseleave');
  expect(info.attributes('aria-expanded')).toBe('false');
});

it('shows red Error with the failure information and no enabled download', async () => {
  current = makeJob('failed');
  await open(current);
  expect(bar().attributes('data-state')).toBe('error');
  expect(bar().find('.fa-x').exists()).toBe(true);
  await bar()
    .get('button[aria-label="Generation information"]')
    .trigger('click');
  expect(bar().get('[role=tooltip]').text()).toBe(current.message);
  expect(wrapper!.find('a[aria-label="Download PDF"]').exists()).toBe(false);
});
it('reports submission errors in the bar without requesting a job', async () => {
  await open();
  await wrapper!.setProps({ error: 'Choose a file for logo.' });
  expect(bar().attributes('data-state')).toBe('error');
  expect(bar().get('[role=tooltip]').text()).toBe('Choose a file for logo.');
  expect(apiMock).not.toHaveBeenCalled();
});
it('shows multiline technical errors as scrollable literal text in the information section', async () => {
  current = {
    ...makeJob('failed'),
    message:
      'LaTeX compilation failed.\n\nTechnical details (may contain document content):\nl.7 <script>alert(1)</script>',
  };
  await open(current);
  await bar()
    .get('button[aria-label="Generation information"]')
    .trigger('click');
  const details = bar().get('[role=tooltip]');
  expect(details.element.textContent).toBe(current.message);
  expect(details.find('script').exists()).toBe(false);
  expect(details.classes()).toContain('whitespace-pre-wrap');
  expect(details.classes()).toContain('overflow-auto');
  expect(details.classes()).toContain('max-h-80');
});
it('keeps diagnostic information open while keyboard focus moves into it and restores focus on Escape', async () => {
  current = makeJob('failed');
  await open(current);
  document.body.appendChild(wrapper!.element);
  const info = bar().get('button[aria-label="Generation information"]');
  (info.element as HTMLElement).focus();
  await flushPromises();
  const panel = bar().get('[role=tooltip]');
  expect(panel.attributes('tabindex')).toBe('0');
  (panel.element as HTMLElement).focus();
  await flushPromises();
  expect(panel.isVisible()).toBe(true);
  await panel.trigger('keydown', { key: 'Escape' });
  expect(info.attributes('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(info.element);
  await info.trigger('focus');
  await panel.trigger('focusout', { relatedTarget: null });
  expect(info.attributes('aria-expanded')).toBe('false');
});
it('allows retry after polling fails and stops polling after completion', async () => {
  apiMock.mockRejectedValueOnce(new Error('Status unavailable'));
  await open(current);
  expect(bar().attributes('data-state')).toBe('error');
  current = makeJob('ok');
  await bar().get('button[aria-label="Retry status"]').trigger('click');
  await flushPromises();
  expect(bar().attributes('data-state')).toBe('generated');
  const count = apiMock.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(apiMock).toHaveBeenCalledTimes(count);
});
it('shows PDF load failures in the bar and can retry the preview', async () => {
  current = makeJob('ok');
  pdfError = true;
  await open(current);
  expect(bar().attributes('data-state')).toBe('error');
  expect(bar().get('[role=tooltip]').text()).toContain(
    'PDF preview unavailable',
  );
  pdfError = false;
  await bar().get('button[aria-label="Retry preview"]').trigger('click');
  await flushPromises();
  expect(wrapper!.find('[data-pdf-source]').exists()).toBe(true);
  expect(bar().attributes('data-state')).toBe('generated');
});
it('keeps download available and allows retry when PDF rendering fails', async () => {
  current = makeJob('ok');
  await open(current);
  wrapper!
    .getComponent(VuePdfEmbed)
    .vm.$emit('rendering-failed', new Error('Invalid PDF'));
  await wrapper!.vm.$nextTick();
  expect(bar().attributes('data-state')).toBe('error');
  expect(bar().get('[role=tooltip]').text()).toContain('PDF preview');
  expect(wrapper!.find('a[aria-label="Download PDF"]').exists()).toBe(true);
  await bar().get('button[aria-label="Retry preview"]').trigger('click');
  await flushPromises();
  expect(wrapper!.get('[data-pdf-source]').attributes('data-pdf-source')).toBe(
    'blob:preview',
  );
  expect(bar().attributes('data-state')).toBe('generated');
});
it('does not restart polling when an in-flight response finishes after unmount', async () => {
  let complete!: (value: unknown) => void;
  apiMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await open(current);
  wrapper!.unmount();
  wrapper = undefined;
  complete({ job: current });
  await flushPromises();
  expect(vi.getTimerCount()).toBe(0);
});
