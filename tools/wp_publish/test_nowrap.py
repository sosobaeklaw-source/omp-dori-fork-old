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


if __name__ == "__main__":
    unittest.main()
