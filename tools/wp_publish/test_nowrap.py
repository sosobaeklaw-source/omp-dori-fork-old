import unittest

from nowrap import OPEN, nowrap


def runs(html: str) -> list[str]:
    return [p.split("</span>")[0] for p in html.split(OPEN)[1:]]


class NowrapTest(unittest.TestCase):
    def test_numbers_units_articles_dates_and_formulas_stay_whole(self) -> None:
        body = (
            "<p>2018. 9. 19. 선고 판결. 셋째, 500·1,000·2,000헤르츠 주파수 간. 산식 {(a+2b+2c+d)÷6}으로 계산. "
            "70+(80×2)+(80×2)+100 = 490을 나눈다. 같은 법 제103조 제3항에 따라 90일 이내.</p>"
        )
        self.assertEqual(
            runs(nowrap(body)),
            ["2018. 9. 19.", "500·1,000·2,000헤르츠", "{(a+2b+2c+d)÷6}", "70+(80×2)+(80×2)+100 = 490", "제103조 제3항",
             "90일"],
        )

    def test_attributes_scripts_and_wrapped_runs_are_left_alone(self) -> None:
        body = '<a href="https://www.law.go.kr/법령/x/제53조" title="90일">제53조</a><script>var a = 1+2;</script>'
        out = nowrap(body)
        self.assertIn('href="https://www.law.go.kr/법령/x/제53조" title="90일"', out)
        self.assertIn("<script>var a = 1+2;</script>", out)
        self.assertEqual(nowrap(out), out)

    def test_a_law_link_ending_in_an_article_keeps_the_next_paragraph_number_with_it(self) -> None:
        out = nowrap('<a href="x">산재법 제57조</a> 제3항·제4항).')
        self.assertIn("</a>\u00a0", out)

    def test_a_date_or_article_right_after_an_opening_bracket_is_one_run(self) -> None:
        out = runs(nowrap("<p>개정법(2024. 1. 1. 시행)과 심사청구(제103조 제3항) 기한.</p>"))
        self.assertIn("2024. 1. 1.", out)
        self.assertIn("제103조 제3항", out)

    def test_svg_title_option_textarea_pre_and_code_are_left_alone(self) -> None:
        body = (
            "<html><head><title>90일 기한</title></head><body>"
            '<svg viewBox="0 0 10 10"><text x="1" y="1">90일</text></svg>'
            "<select><option>2,000헤르츠</option></select><textarea>제103조 제3항</textarea>"
            "<pre><code>a = 1+2</code></pre><code>x=90</code></body></html>"
        )
        self.assertEqual(nowrap(body), body)

    def test_a_run_wider_than_a_phone_column_is_left_breakable(self) -> None:
        long = "근로복지공단서울지역본부산재보상2부(2024년)"  # 27 characters, about 450px of Hangul at 16px
        self.assertEqual(runs(nowrap(f"<p>{long} 담당, 공단(2024년) 담당</p>")), ["2024년)"])

    def test_a_gt_inside_an_attribute_or_comment_does_not_end_the_tag(self) -> None:
        body = '<a title="40dB > 25dB 90일" href=\'x>1\'>링크</a><!-- c > 1+2 90일 -->'
        self.assertEqual(nowrap(body), body)

    def test_headings_are_left_alone(self) -> None:
        body = '<h1>제103조 제3항</h1><h2 class="t">근로복지공단서울지역본부(2024년) 90일</h2><h3>500·1,000헤르츠</h3>'
        self.assertEqual(nowrap(body), body)

    def test_a_date_stuck_to_an_entity_is_one_run(self) -> None:
        self.assertEqual(runs(nowrap("<p>1심&#8211;2018. 9. 19. 선고</p>")), ["1심&#8211;2018. 9. 19."])


if __name__ == "__main__":
    unittest.main()
