import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory } from 'vue-router';
import App from '../src/App.vue';
import { setEditorText } from './helpers/code-editor';
import { createAppRouter } from '../src/router';
import { session } from '../src/api/client';
import type { ShapeField } from '../src/api/types';

let wrapper: VueWrapper | undefined;
let fields: ShapeField[] | null;
let states: string[];
let calls: { path: string; init: RequestInit }[];
let failStatus = false;
let failPdf = false;
const job = (status: string) => ({
  id: 'job',
  templateId: 'deleted',
  templateName: 'Letter',
  status,
  message: status === 'failed' ? 'Compilation failed' : status,
  timestamp: '2026-11-13T00:00:00Z',
  pdfFilename: status === 'ok' ? 'result.pdf' : null,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('navigator', { pdfViewerEnabled: true });
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:pdf');
      static revokeObjectURL = vi.fn();
    },
  );
  fields = [
    { variable: 'name', label: 'Name', type: 'text', optional: false },
    { variable: 'notes', label: 'Notes', type: 'longtext', optional: true },
    { variable: 'count', label: 'Count', type: 'number', optional: false },
    { variable: 'flag', label: 'Flag', type: 'boolean', optional: true },
  ];
  states = ['queued'];
  calls = [];
  failStatus = false;
  failPdf = false;
  session.user = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit = {}) => {
      calls.push({ path, init });
      let data: unknown;
      if (path === '/api/auth/me')
        data = {
          user: {
            id: 'self',
            username: 'reader',
            role: 'user',
            disabled: false,
          },
          csrfToken: 'csrf',
        };
      else if (path.endsWith('/resources')) data = { aliases: ['logo'] };
      else if (path === '/api/templates/letter')
        data = {
          template: {
            id: 'letter',
            name: 'Letter',
            manifest: {
              version: 1,
              shape: fields === null ? null : { fields },
            },
          },
        };
      else if (path.endsWith('/generations')) data = { job: job('queued') };
      else if (path.endsWith('/pdf')) {
        if (failPdf)
          return new Response(
            JSON.stringify({ error: 'Could not load PDF preview' }),
            { status: 503 },
          );
        return new Response(
          new Blob(['%PDF-1.7'], { type: 'application/pdf' }),
        );
      } else if (path === '/api/jobs')
        data = { jobs: [job('ok'), { ...job('failed'), id: 'failed' }] };
      else if (path === '/api/jobs/job') {
        if (failStatus)
          return new Response(JSON.stringify({ error: 'Status unavailable' }), {
            status: 503,
          });
        data = { job: job(states.length > 1 ? states.shift()! : states[0]) };
      } else throw new Error(`Unexpected request ${path}`);
      return new Response(JSON.stringify(data));
    }),
  );
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function open(path = '/templates/letter/generate') {
  const router = createAppRouter(createMemoryHistory());
  await router.push(path);
  wrapper = mount(App, { global: { plugins: [router] } });
  await flushPromises();
  return router;
}
async function submit() {
  await wrapper!.get('form').trigger('submit');
  await flushPromises();
}
async function upload() {
  const input = wrapper!.get('input[type=file]');
  Object.defineProperty(input.element, 'files', {
    configurable: true,
    value: [new File(['image'], 'logo.png')],
  });
  await input.trigger('change');
}
describe('single generation', () => {
  it('sends typed JSON with zero and false, omits optional blanks, uploads aliases, and keeps the form beside preview', async () => {
    const router = await open();
    expect(wrapper!.find('textarea#field-notes').exists()).toBe(true);
    expect(wrapper!.text()).toContain('logo');
    await wrapper!.get('#field-name').setValue('Ada');
    await wrapper!.get('#field-count').setValue('0');
    await wrapper!.get('#field-flag').setValue('false');
    await upload();
    await submit();
    const request = calls.find((c) => c.path.endsWith('/generations'))!;
    const body = request.init.body as FormData;
    expect(JSON.parse(String(body.get('data')))).toEqual({
      name: 'Ada',
      count: 0,
      flag: false,
    });
    expect(body.get('logo')).toBeInstanceOf(File);
    expect(request.init.headers).toMatchObject({ 'X-CSRF-Token': 'csrf' });
    expect(request.init.credentials).toBe('include');
    expect(router.currentRoute.value.path).toBe('/templates/letter/generate');
    expect(wrapper!.find('[aria-label="Document preview"]').exists()).toBe(
      true,
    );
  });
  it('switches to preview only after success and releases the PDF URL on unmount', async () => {
    states = ['queued', 'ok'];
    await open();
    await wrapper!.get('#field-name').setValue('Ada');
    await wrapper!.get('#field-count').setValue('0');
    await upload();
    await submit();
    const body = calls.find((c) => c.path.endsWith('/generations'))!.init
      .body as FormData;
    expect(JSON.parse(String(body.get('data')))).toEqual({
      name: 'Ada',
      count: 0,
    });
    expect(
      wrapper!
        .get('button[aria-controls="generation-form"]')
        .attributes('aria-pressed'),
    ).toBe('true');
    await vi.advanceTimersByTimeAsync(2000);
    await flushPromises();
    expect(
      wrapper!
        .get('button[aria-controls="generation-preview"]')
        .attributes('aria-pressed'),
    ).toBe('true');
    expect(wrapper!.get('iframe[title="PDF preview"]').attributes('src')).toBe(
      'blob:pdf',
    );
    wrapper!.unmount();
    wrapper = undefined;
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:pdf');
  });

  it('does not navigate when a submission finishes after leaving the workspace', async () => {
    const router = await open();
    const originalFetch = fetch;
    let complete!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, init?: RequestInit) =>
        path.endsWith('/generations')
          ? new Promise<Response>((resolve) => {
              complete = resolve;
            })
          : originalFetch(path, init),
      ),
    );
    await wrapper!.get('#field-name').setValue('Ada');
    await wrapper!.get('#field-count').setValue('1');
    await upload();
    await submit();
    await router.push('/jobs');
    await flushPromises();
    complete(new Response(JSON.stringify({ job: job('queued') })));
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/jobs');
  });

  it('rejects oversized uploads and preserves the form when submission fails', async () => {
    await open();
    await wrapper!.get('#field-name').setValue('Ada');
    await wrapper!.get('#field-count').setValue('1');
    const file = new File(['x'], 'logo.png');
    Object.defineProperty(file, 'size', { value: 21 * 1024 * 1024 });
    const input = wrapper!.get('input[type=file]');
    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [file],
    });
    await input.trigger('change');
    await submit();
    expect(wrapper!.get('[role=alert]').text()).toContain('20 MiB');
    expect(calls.some((c) => c.path.endsWith('/generations'))).toBe(false);
    await upload();
    const originalFetch = fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, init?: RequestInit) =>
        path.endsWith('/generations')
          ? Promise.resolve(
              new Response(
                JSON.stringify({ error: 'Template changed; missing resource' }),
                { status: 400 },
              ),
            )
          : originalFetch(path, init),
      ),
    );
    await submit();
    expect(wrapper!.get('[role=alert]').text()).toContain('Template changed');
    expect(
      (wrapper!.get('#field-name').element as HTMLInputElement).value,
    ).toBe('Ada');
  });

  it('rejects missing required values and files before submission', async () => {
    await open();
    await submit();
    expect(wrapper!.get('[role=alert]').text()).toContain('Name');
    await wrapper!.get('#field-name').setValue('Ada');
    await wrapper!.get('#field-count').setValue('1');
    await submit();
    expect(wrapper!.get('[role=alert]').text()).toContain('logo');
    expect(calls.some((c) => c.path.endsWith('/generations'))).toBe(false);
  });
  it.each(['{', '[]', 'null', '4'])(
    'rejects invalid or non-object JSON %s',
    async (value) => {
      fields = null;
      await open();
      await setEditorText(wrapper!, value);
      await upload();
      await submit();
      expect(wrapper!.get('[role=alert]').text()).toContain('JSON object');
      expect(calls.some((c) => c.path.endsWith('/generations'))).toBe(false);
    },
  );
  it('accepts concrete JSON and leaves optional booleans unset', async () => {
    fields = null;
    await open();
    await setEditorText(wrapper!, '{"zero":0,"flag":false}');
    await upload();
    await submit();
    expect(
      JSON.parse(
        String(
          (
            calls.find((c) => c.path.endsWith('/generations'))!.init
              .body as FormData
          ).get('data'),
        ),
      ),
    ).toEqual({ zero: 0, flag: false });
  });
});
describe('retained jobs', () => {
  it('consolidates job-detail status, submission details, and download above the PDF', async () => {
    states = ['ok'];
    await open('/jobs/job');
    const bar = wrapper!.get('[aria-label="Generation status"]');
    expect(bar.attributes('data-state')).toBe('generated');
    expect(bar.find('.fa-check').exists()).toBe(true);
    expect(bar.get('a[aria-label="Download PDF"]').attributes('href')).toBe(
      '/api/jobs/job/pdf',
    );
    expect(
      wrapper!.findAll('p').some((p) => p.text().startsWith('Submitted ')),
    ).toBe(false);
    expect(
      wrapper!.findAll('p').some((p) => p.text() === 'PDF generated'),
    ).toBe(false);
    await bar
      .get('button[aria-label="Generation information"]')
      .trigger('focus');
    expect(bar.get('[role=tooltip]').text()).toContain(
      'Generation succeeded for document submitted at',
    );
    expect(
      wrapper!.get('[aria-label="Document preview"]').find('iframe').exists(),
    ).toBe(true);
    expect(wrapper!.findAll('[aria-label="Generation status"]')).toHaveLength(
      1,
    );
  });
  it('uses the shared toolbar to retry PDF loading on job detail', async () => {
    states = ['ok'];
    failPdf = true;
    await open('/jobs/job');
    const bar = wrapper!.get('[aria-label="Generation status"]');
    expect(bar.attributes('data-state')).toBe('error');
    expect(bar.get('[role=tooltip]').text()).toContain(
      'Could not load PDF preview',
    );
    expect(bar.find('a[aria-label="Download PDF"]').exists()).toBe(true);
    failPdf = false;
    await bar.get('button[aria-label="Retry preview"]').trigger('click');
    await flushPromises();
    expect(bar.attributes('data-state')).toBe('generated');
    expect(wrapper!.find('iframe[title="PDF preview"]').exists()).toBe(true);
  });

  it.each(['ok', 'failed'])(
    'polls queued → generating → %s and stops at completion',
    async (terminal) => {
      states = ['queued', 'generating', terminal];
      await open('/jobs/job');
      expect(wrapper!.get('[aria-label="Generation status"]').text()).toContain(
        'Generating...',
      );
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();
      expect(wrapper!.get('[aria-label="Generation status"]').text()).toContain(
        'Generating...',
      );
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();
      expect(wrapper!.text()).toContain(
        terminal === 'failed' ? 'Compilation failed' : 'Generated',
      );
      expect(wrapper!.find('a[href="/api/jobs/job/pdf"]').exists()).toBe(
        terminal === 'ok',
      );
      const count = calls.length;
      await vi.advanceTimersByTimeAsync(10000);
      expect(calls).toHaveLength(count);
    },
  );
  it('stops polling on unmount', async () => {
    await open('/jobs/job');
    wrapper!.unmount();
    wrapper = undefined;
    const count = calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(calls).toHaveLength(count);
  });
  it('does not schedule a new poll after an in-flight status read finishes on unmount', async () => {
    let complete!: (response: Response) => void;
    const originalFetch = fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, init?: RequestInit) =>
        path === '/api/jobs/job'
          ? new Promise<Response>((resolve) => {
              complete = resolve;
            })
          : originalFetch(path, init),
      ),
    );
    await open('/jobs/job');
    wrapper!.unmount();
    wrapper = undefined;
    complete(new Response(JSON.stringify({ job: job('queued') })));
    await flushPromises();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not allocate a PDF URL when its request finishes after unmount', async () => {
    states = ['ok'];
    let complete!: (response: Response) => void;
    const originalFetch = fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, init?: RequestInit) =>
        path.endsWith('/pdf')
          ? new Promise<Response>((resolve) => {
              complete = resolve;
            })
          : originalFetch(path, init),
      ),
    );
    await open('/jobs/job');
    wrapper!.unmount();
    wrapper = undefined;
    complete(new Response(new Blob(['%PDF'], { type: 'application/pdf' })));
    await flushPromises();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('shows status errors and allows retry', async () => {
    failStatus = true;
    await open('/jobs/job');
    expect(wrapper!.get('[role=alert]').text()).toContain('Status unavailable');
    failStatus = false;
    await wrapper!
      .findAll('button')
      .find((b) => b.text() === 'Retry')!
      .trigger('click');
    await flushPromises();
    expect(wrapper!.get('[aria-label="Generation status"]').text()).toContain(
      'Generating...',
    );
  });
  it('shows history and authorized download links without fetching deleted templates', async () => {
    await open('/jobs');
    expect(wrapper!.text()).toContain('Letter');
    expect(wrapper!.get('a[href="/api/jobs/job/pdf"]').text()).toContain(
      'Download',
    );
    expect(wrapper!.find('a[href="/api/jobs/failed/pdf"]').exists()).toBe(
      false,
    );
    expect(calls.some((c) => c.path.startsWith('/api/templates'))).toBe(false);
  });
});
