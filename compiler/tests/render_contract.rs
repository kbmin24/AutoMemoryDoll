use automemorydoll_compiler::render::{render_tex, strip_template_loads};
use serde_json::json;

#[test]
fn escapes_tex_metacharacters_in_ordinary_strings() {
    let data = json!({"value": r"\{}$&%#_^~"});
    let rendered = render_tex("{{ value }}", data.as_object().unwrap()).unwrap();
    assert_eq!(
        rendered,
        r"\textbackslash{}\{\}\$\&\%\#\_\textasciicircum{}\textasciitilde{}"
    );
}

#[test]
fn safe_filter_inserts_raw_tex() {
    let data = json!({"value": r"\textbf{A&B}"});
    let rendered = render_tex("{{ value|safe }}", data.as_object().unwrap()).unwrap();
    assert_eq!(rendered, r"\textbf{A&B}");
}

#[test]
fn missing_null_boolean_and_number_values_render_as_specified() {
    let data = json!({"empty": null, "yes": true, "no": false, "count": 123});
    let rendered = render_tex(
        "{{ missing }}|{{ empty }}|{{ yes }}|{{ no }}|{{ count }}",
        data.as_object().unwrap(),
    )
    .unwrap();
    assert_eq!(rendered, "||true|false|123");
}

#[test]
fn safe_filter_keeps_json_scalar_spellings() {
    let data = json!({"empty": null, "yes": true, "no": false, "count": 123});
    let rendered = render_tex(
        "{{ empty|safe }}|{{ yes|safe }}|{{ no|safe }}|{{ count|safe }}",
        data.as_object().unwrap(),
    )
    .unwrap();
    assert_eq!(rendered, "|true|false|123");
}

#[test]
fn dotted_top_level_keys_do_not_invalidate_the_context() {
    let data = json!({"profile.name": "Grace", "name": "Ada"});
    assert_eq!(
        render_tex("{{ name }}", data.as_object().unwrap()).unwrap(),
        "Ada"
    );
}

#[test]
fn ordinary_loops_conditions_and_expressions_keep_working() {
    let data = json!({"items": ["a", "b"], "show": true});
    let rendered = render_tex(
        "{% if show %}{% for item in items %}{{ item }}{% endfor %}{% endif %}",
        data.as_object().unwrap(),
    )
    .unwrap();
    assert_eq!(rendered, "ab");
}

#[test]
fn removes_include_import_and_from_import_tags() {
    let source = "A{% include 'other.tex' %}B{% import \"macros.tex\" as m %}C{% from 'macros.tex' import foo %}D";
    assert_eq!(strip_template_loads(source), "ABCD");
    assert_eq!(
        render_tex(source, json!({}).as_object().unwrap()).unwrap(),
        "ABCD"
    );
}

#[test]
fn removes_whitespace_control_and_quoted_delimiter_variants() {
    let source = "A{%- include \"other%}file.tex\" -%}B{%+ import 'macros.tex' as m +%}C{% from 'macros.tex' import foo as bar -%}D";
    assert_eq!(strip_template_loads(source), "ABCD");
}

#[test]
fn preserves_tag_like_text_in_comments_raw_blocks_and_string_literals() {
    let source = "{# {% include 'comment.tex' %} #}{% raw %}{% include 'literal.tex' %}{% endraw %}{{ \"{% include 'text.tex' %}\"|safe }}";
    assert_eq!(strip_template_loads(source), source);
    assert_eq!(
        render_tex(source, json!({}).as_object().unwrap()).unwrap(),
        "{% include 'literal.tex' %}{% include 'text.tex' %}"
    );
}

#[test]
fn raw_text_with_unmatched_quotes_does_not_hide_a_later_load() {
    let source = "{% raw %}{% include 'literal %}{% endraw %}{% include 'outside.tex' %}";
    assert_eq!(
        strip_template_loads(source),
        "{% raw %}{% include 'literal %}{% endraw %}"
    );
}

#[test]
fn leaves_unrelated_tags_and_text_unchanged() {
    let source = "before {% if true %}{{ value }}{% endif %} after";
    assert_eq!(strip_template_loads(source), source);
}
